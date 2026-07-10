/*
 * dbt integration: run the SQL part of a ggsql query in a dbt project via
 * the dbt CLI (`dbt show`), so Jinja ({{ ref(...) }}, macros) is compiled
 * and the query executes against the project's target warehouse. The rows
 * come back as JSON, get cached to a local file, and the VISUALISE part is
 * rendered by the normal runner reading that file (splitting logic lives
 * in querySplit.ts).
 */

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { GgsqlError, QueryCancelledError } from './errors';
import { parseJsonDocuments } from './runner';
import { log } from './logging';

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
export function runDbtShow(sql: string, projectRoot: string, signal?: AbortSignal): Promise<object[]> {
    const executable = getDbtPath();
    log(`dbt show started (executable: ${executable}, project: ${projectRoot})`);

    return new Promise((resolve, reject) => {
        cp.execFile(
            executable,
            ['--quiet', 'show', '--inline', sql, '--output', 'json', '--limit', '-1'],
            {
                cwd: projectRoot,
                maxBuffer: 256 * 1024 * 1024,
                timeout: 10 * 60 * 1000,
                signal,
            },
            (error, stdout, stderr) => {
                if (error) {
                    if (signal?.aborted) {
                        reject(new QueryCancelledError('The query was cancelled.'));
                        return;
                    }
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
