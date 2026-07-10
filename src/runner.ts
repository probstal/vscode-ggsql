/*
 * Runs ggsql queries through the ggsql CLI.
 *
 * Each query is executed as `ggsql exec --reader <reader> <query>`; the CLI
 * writes a Vega-Lite spec (JSON) to stdout on success and an error message
 * to stderr on failure.
 */

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { log } from './logging';

export interface RunResult {
    /** Vega-Lite specs produced by the query (usually one) */
    specs: object[];
    /** Non-spec output (verbose logs, warnings) */
    stderr: string;
}

export class GgsqlError extends Error {}

/** The run was aborted (user cancel or superseded by a newer run). */
export class QueryCancelledError extends Error {}

export interface RunOptions {
    /** Working directory for the CLI (so relative file paths like
     *  FROM 'data.csv' resolve next to the document) */
    cwd?: string;
    /** Reader to use instead of the `ggsql.reader` setting */
    reader?: string;
    /** Kills the CLI process when aborted */
    signal?: AbortSignal;
}

function getConfig(): { executable: string; reader: string } {
    const config = vscode.workspace.getConfiguration('ggsql');
    const executable = config.get<string>('executablePath', '').trim() || 'ggsql';
    const reader = config.get<string>('reader', '').trim() || 'duckdb://memory';
    return { executable, reader };
}

/**
 * Extract consecutive top-level JSON values from a string.
 * Handles both a single spec and multiple concatenated specs.
 */
export function parseJsonDocuments(text: string): object[] {
    const docs: object[] = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
        } else if (ch === '{') {
            if (depth === 0) {
                start = i;
            }
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0 && start >= 0) {
                docs.push(JSON.parse(text.slice(start, i + 1)));
                start = -1;
            }
        }
    }

    return docs;
}

/**
 * Execute a ggsql query via the CLI and return the resulting Vega-Lite specs.
 * Rejects with QueryCancelledError when options.signal aborts the run.
 */
export function runQuery(query: string, options: RunOptions = {}): Promise<RunResult> {
    const { executable, reader: configuredReader } = getConfig();
    const reader = options.reader ?? configuredReader;
    log(`Running ggsql exec --reader ${reader} (cwd: ${options.cwd ?? process.cwd()})`);

    return new Promise((resolve, reject) => {
        cp.execFile(
            executable,
            ['exec', '--reader', reader, query],
            {
                cwd: options.cwd,
                maxBuffer: 256 * 1024 * 1024,
                timeout: 5 * 60 * 1000,
                signal: options.signal,
            },
            (error, stdout, stderr) => {
                if (error) {
                    if (options.signal?.aborted) {
                        reject(new QueryCancelledError('The query was cancelled.'));
                        return;
                    }
                    const errnoError = error as NodeJS.ErrnoException;
                    if (errnoError.code === 'ENOENT') {
                        reject(new GgsqlError(
                            `Could not find '${executable}'. Install the ggsql CLI or set "ggsql.executablePath" in settings.`
                        ));
                        return;
                    }
                    const message = stderr.trim() || error.message;
                    reject(new GgsqlError(message));
                    return;
                }

                try {
                    const specs = parseJsonDocuments(stdout);
                    if (specs.length === 0) {
                        reject(new GgsqlError(
                            stderr.trim() || 'ggsql produced no visualization output.'
                        ));
                        return;
                    }
                    resolve({ specs, stderr: stderr.trim() });
                } catch (e) {
                    reject(new GgsqlError(`Failed to parse ggsql output as JSON: ${e}`));
                }
            }
        );
    });
}

/**
 * Working directory to run queries in for a given document: the document's
 * folder if saved to disk, otherwise the first workspace folder.
 */
export function workingDirFor(document: vscode.TextDocument): string | undefined {
    if (document.uri.scheme === 'file') {
        return path.dirname(document.uri.fsPath);
    }
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
