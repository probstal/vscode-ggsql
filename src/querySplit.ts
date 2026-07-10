/*
 * Splitting ggsql queries at the VISUALISE boundary.
 *
 * Used by two consumers with the same need: run the SQL part on a real
 * engine (dbt for dbt-project files, duckdb-wasm for the standalone
 * engine), then render the VISUALISE part from the result. No vscode
 * imports — this module is also bundled into the wasm worker.
 */

import { GgsqlError } from './errors';

export interface SplitQuery {
    /** SQL prefix (may contain Jinja) for the data engine */
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
        } else if (ch === '$' && next === '$') {
            // DuckDB dollar-quoted string
            i = skipUntil(i + 2, '$$');
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
 * Split a script into statements at top-level semicolons (outside
 * strings, comments, Jinja, and parentheses). Empty statements are
 * dropped.
 */
export function splitStatements(text: string): string[] {
    const boundaries: number[] = [];
    scanCode(text, (i, depth) => {
        if (depth === 0 && text[i] === ';') {
            boundaries.push(i);
        }
    });
    const statements: string[] = [];
    let start = 0;
    for (const boundary of boundaries) {
        statements.push(text.slice(start, boundary));
        start = boundary + 1;
    }
    statements.push(text.slice(start));
    return statements.map(s => s.trim()).filter(s => s.length > 0);
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

export interface SplitQueryPlan {
    /** SQL for the data engine (dbt or duckdb) */
    sql: string;
    /** ggsql query rendering the VISUALISE part from the engine's result;
     *  `source` is where the result lives (file path or table name) */
    buildRenderQuery(source: string): string;
}

export function quotePath(path: string): string {
    return `'${path.replace(/'/g, "''")}'`;
}

/**
 * Plan how to run a split query: what SQL to send to the data engine and
 * how to rewrite the VISUALISE part against the engine's result.
 *
 * If the SQL part ends in a SELECT (Pattern A), it runs as-is and the
 * result is prepended as `SELECT * FROM '<source>'`. If it doesn't — e.g.
 * the query jumps from the last CTE straight to `VISUALISE ... FROM cte`
 * (Pattern B) — a `select * from <source>` using the VISUALISE clause's
 * FROM is appended for the engine, and that FROM is repointed at the
 * result for rendering.
 *
 * Returns undefined if there is no VISUALISE clause; throws GgsqlError if
 * the data source cannot be determined.
 */
export function planSplitQuery(text: string): SplitQueryPlan | undefined {
    const split = splitVisualise(text);
    if (!split) {
        return undefined;
    }

    if (hasTopLevelSelect(split.sql)) {
        return {
            sql: split.sql,
            buildRenderQuery: source =>
                `SELECT * FROM ${quotePath(source)}\n${split.visualise}`,
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
        sql: `${split.sql ? split.sql + '\n' : ''}select * from ${from.source}`,
        buildRenderQuery: source =>
            split.visualise.slice(0, from.start) +
            quotePath(source) +
            split.visualise.slice(from.end),
    };
}
