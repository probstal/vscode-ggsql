/*
 * dbt integration: run the SQL part of a ggsql query in a dbt project via
 * the dbt CLI (`dbt show`), so Jinja ({{ ref(...) }}, macros) is compiled
 * and the query executes against the project's target warehouse. The rows
 * come back as JSON, get cached to a local file, and the VISUALISE part is
 * rendered by ggsql reading that file through its duckdb reader.
 */

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { GgsqlError, parseJsonDocuments } from './runner';
import { log } from './logging';

export interface SplitQuery {
    /** SQL prefix (may contain Jinja) executed via `dbt show` */
    sql: string;
    /** VISUALISE clause onward, passed through to ggsql */
    visualise: string;
}

/**
 * Walk over SQL code, skipping strings, quoted identifiers, SQL comments,
 * and Jinja blocks, and tracking parenthesis depth. `visit` is called for
 * every code character with its position and the current depth; it may
 * return a new position to jump to (e.g. text.length to stop early).
 */
function scanCode(text: string, visit: (i: number, depth: number) => number | void): void {
    let depth = 0;

    const skipUntil = (from: number, end: string): number => {
        const idx = text.indexOf(end, from);
        return idx === -1 ? text.length : idx + end.length;
    };

    for (let i = 0; i < text.length; ) {
        const ch = text[i];
        const next = text[i + 1];

        if (ch === '-' && next === '-') {
            i = skipUntil(i + 2, '\n');
        } else if (ch === '/' && next === '*') {
            i = skipUntil(i + 2, '*/');
        } else if (ch === '{' && next === '{') {
            i = skipUntil(i + 2, '}}');
        } else if (ch === '{' && next === '%') {
            i = skipUntil(i + 2, '%}');
        } else if (ch === '{' && next === '#') {
            i = skipUntil(i + 2, '#}');
        } else if (ch === "'" || ch === '"') {
            // SQL strings escape the quote by doubling it ('it''s')
            i++;
            while (i < text.length) {
                if (text[i] === ch) {
                    if (text[i + 1] === ch) {
                        i += 2;
                        continue;
                    }
                    i++;
                    break;
                }
                i++;
            }
        } else if (ch === '(') {
            depth++;
            i++;
        } else if (ch === ')') {
            depth = Math.max(0, depth - 1);
            i++;
        } else {
            const jump = visit(i, depth);
            i = typeof jump === 'number' ? jump : i + 1;
        }
    }
}

function isWordStart(text: string, i: number): boolean {
    return i === 0 || !/[\w$.]/.test(text[i - 1]);
}

/**
 * Split a query at the top-level VISUALISE (or VISUALIZE) keyword.
 *
 * The keyword only counts outside strings, quoted identifiers, SQL
 * comments, Jinja expressions/statements/comments, and parentheses, so a
 * column alias like `sub.visualise` or a commented-out clause doesn't
 * split the query. Returns undefined if no VISUALISE clause is found.
 */
export function splitVisualise(text: string): SplitQuery | undefined {
    let at = -1;
    scanCode(text, (i, depth) => {
        if (
            depth === 0 &&
            (text[i] === 'v' || text[i] === 'V') &&
            isWordStart(text, i) &&
            /^visuali[sz]e\b/i.test(text.slice(i, i + 10))
        ) {
            at = i;
            return text.length;
        }
    });
    if (at === -1) {
        return undefined;
    }
    return { sql: text.slice(0, at).trim(), visualise: text.slice(at).trim() };
}

/**
 * Whether the SQL contains a SELECT at parenthesis depth 0 — i.e. whether
 * its final statement produces a result set on its own. A `WITH ... cte`
 * prefix without a main SELECT has all its SELECTs inside parentheses.
 */
function hasTopLevelSelect(sql: string): boolean {
    let found = false;
    scanCode(sql, (i, depth) => {
        if (
            depth === 0 &&
            (sql[i] === 's' || sql[i] === 'S') &&
            isWordStart(sql, i) &&
            /^select\b/i.test(sql.slice(i, i + 7))
        ) {
            found = true;
            return sql.length;
        }
    });
    return found;
}

/** Clause keywords that end the VISUALISE clause itself. */
const CLAUSE_AFTER_VISUALISE = /^(draw|scale|project|facet|label|theme)\b/i;

/**
 * Find the data source of the leading VISUALISE clause: the token after a
 * top-level FROM, up to the next clause keyword (DRAW, SCALE, ...).
 * `start`/`end` delimit the source within `visualise`.
 */
function findVisualiseFrom(
    visualise: string,
): { start: number; end: number; source: string } | undefined {
    let result: { start: number; end: number; source: string } | undefined;
    scanCode(visualise, (i, depth) => {
        if (depth !== 0) {
            return;
        }
        if (isWordStart(visualise, i) && CLAUSE_AFTER_VISUALISE.test(visualise.slice(i, i + 8))) {
            return visualise.length;
        }
        if (
            (visualise[i] === 'f' || visualise[i] === 'F') &&
            isWordStart(visualise, i) &&
            /^from\b/i.test(visualise.slice(i, i + 5))
        ) {
            let start = i + 4;
            while (start < visualise.length && /\s/.test(visualise[start])) {
                start++;
            }
            // Quoted file path ('data.csv') or (dotted/quoted) identifier,
            // including ggsql:dataset references.
            const match = /^(?:'(?:[^']|'')*'|[\w$.:"]+)/.exec(visualise.slice(start));
            if (match) {
                result = { start, end: start + match[0].length, source: match[0] };
            }
            return visualise.length;
        }
    });
    return result;
}

export interface DbtQueryPlan {
    /** (Jinja-)SQL to compile and execute via `dbt show` */
    dbtSql: string;
    /** ggsql query that renders the VISUALISE part from the cache file */
    buildRenderQuery(cachePath: string): string;
}

function quotePath(path: string): string {
    return `'${path.replace(/'/g, "''")}'`;
}

/**
 * Plan how to run a dbt document: what SQL to send to `dbt show` and how
 * to rewrite the VISUALISE part against the local cache file.
 *
 * If the SQL part ends in a SELECT (Pattern A), it runs as-is and the
 * cache is prepended as `SELECT * FROM '<cache>'`. If it doesn't — e.g.
 * the query jumps from the last CTE straight to `VISUALISE ... FROM cte`
 * (Pattern B) — a `select * from <source>` using the VISUALISE clause's
 * FROM is appended for dbt, and that FROM is repointed at the cache file
 * for rendering.
 *
 * Returns undefined if there is no VISUALISE clause; throws GgsqlError if
 * the data source cannot be determined.
 */
export function planDbtQuery(text: string): DbtQueryPlan | undefined {
    const split = splitVisualise(text);
    if (!split) {
        return undefined;
    }

    if (hasTopLevelSelect(split.sql)) {
        return {
            dbtSql: split.sql,
            buildRenderQuery: cachePath =>
                `SELECT * FROM ${quotePath(cachePath)}\n${split.visualise}`,
        };
    }

    const from = findVisualiseFrom(split.visualise);
    if (!from) {
        throw new GgsqlError(
            'Cannot determine the data source: the SQL before VISUALISE is not a ' +
            'SELECT and the VISUALISE clause has no FROM.'
        );
    }
    return {
        dbtSql: `${split.sql ? split.sql + '\n' : ''}select * from ${from.source}`,
        buildRenderQuery: cachePath =>
            split.visualise.slice(0, from.start) +
            quotePath(cachePath) +
            split.visualise.slice(from.end),
    };
}

/**
 * Walk upward from a directory looking for dbt_project.yml.
 */
export function findDbtProjectRoot(startDir: string): string | undefined {
    let dir = startDir;
    for (;;) {
        if (fs.existsSync(path.join(dir, 'dbt_project.yml'))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            return undefined;
        }
        dir = parent;
    }
}

function getDbtPath(): string {
    const config = vscode.workspace.getConfiguration('ggsql');
    return config.get<string>('dbtPath', '').trim() || 'dbt';
}

function stripAnsi(text: string): string {
    return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/**
 * Compile and execute a (Jinja-)SQL query in a dbt project and return the
 * result rows. Runs `dbt --quiet show --inline <sql> --output json --limit -1`
 * with the project root as working directory, so refs, macros, and the
 * project's profile/target all resolve exactly like a normal dbt run.
 */
export function runDbtShow(sql: string, projectRoot: string): Promise<object[]> {
    const executable = getDbtPath();
    log(`Running ${executable} show --inline ${sql} (project: ${projectRoot})`);

    return new Promise((resolve, reject) => {
        cp.execFile(
            executable,
            ['--quiet', 'show', '--inline', sql, '--output', 'json', '--limit', '-1'],
            {
                cwd: projectRoot,
                maxBuffer: 256 * 1024 * 1024,
                timeout: 10 * 60 * 1000,
            },
            (error, stdout, stderr) => {
                if (error) {
                    const errnoError = error as NodeJS.ErrnoException;
                    if (errnoError.code === 'ENOENT') {
                        reject(new GgsqlError(
                            `Could not find '${executable}'. Install dbt or set "ggsql.dbtPath" in settings ` +
                            '(e.g. to the dbt inside your project\'s virtualenv).'
                        ));
                        return;
                    }
                    const message = stripAnsi(stderr.trim() || stdout.trim() || error.message);
                    reject(new GgsqlError(`dbt failed: ${message}`));
                    return;
                }

                try {
                    const docs = parseJsonDocuments(stdout);
                    const showDoc = docs.find(
                        doc => Array.isArray((doc as { show?: unknown }).show)
                    ) as { show: object[] } | undefined;
                    if (!showDoc) {
                        reject(new GgsqlError(
                            `dbt did not return result rows. ${stripAnsi(stderr.trim() || stdout.trim())}`
                        ));
                        return;
                    }
                    resolve(showDoc.show);
                } catch (e) {
                    reject(new GgsqlError(`Failed to parse dbt output as JSON: ${e}`));
                }
            }
        );
    });
}

/**
 * Write result rows to a JSON cache file under the extension's global
 * storage and return its filesystem path. The file name is derived from
 * the content hash, so re-running the same data overwrites in place.
 */
export async function writeRowsCache(rows: object[], storageUri: vscode.Uri): Promise<string> {
    const dir = vscode.Uri.joinPath(storageUri, 'dbt-cache');
    await vscode.workspace.fs.createDirectory(dir);
    const content = Buffer.from(JSON.stringify(rows), 'utf8');
    const name = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16) + '.json';
    const file = vscode.Uri.joinPath(dir, name);
    await vscode.workspace.fs.writeFile(file, content);
    return file.fsPath;
}
