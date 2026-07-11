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
import { GgsqlError, QueryCancelledError } from './errors';
import { runStandalone } from './standalone';
import { formatMs, log, logDebug, logRaw, nextRunNumber, oneLine } from './logging';

export { GgsqlError, QueryCancelledError } from './errors';

export interface RunResult {
    /** Vega-Lite specs produced by the query (usually one) */
    specs: object[];
    /** Non-spec output (verbose logs, warnings) */
    stderr: string;
}

export interface RunOptions {
    /** Working directory (so relative file paths like FROM 'data.csv'
     *  resolve next to the document) */
    cwd?: string;
    /** Reader to use instead of the `ggsql.reader` setting (cli engine) */
    reader?: string;
    /** Cancels the run when aborted */
    signal?: AbortSignal;
}

export type Engine = 'standalone' | 'cli';

export function getEngine(): Engine {
    const config = vscode.workspace.getConfiguration('ggsql');
    return config.get<string>('engine', 'standalone') === 'cli' ? 'cli' : 'standalone';
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
 * Execute a ggsql query and return the resulting Vega-Lite specs, either
 * via the ggsql CLI or the bundled wasm engine, per the `ggsql.engine`
 * setting. Rejects with QueryCancelledError when options.signal aborts.
 */
export function runQuery(query: string, options: RunOptions = {}): Promise<RunResult> {
    if (getEngine() === 'standalone') {
        return runStandalone(query, options);
    }
    const { executable, reader: configuredReader } = getConfig();
    const reader = options.reader ?? configuredReader;
    const runNumber = nextRunNumber();
    const startedAt = Date.now();
    log(`run #${runNumber} · cli · started (${executable} exec --reader ${reader})`);

    const logCliRun = (outcome: string, result: string, fullError?: string) => {
        logRaw(
            `run #${runNumber} · cli · ${outcome} · ${formatMs(Date.now() - startedAt)} · cwd: ${options.cwd ?? process.cwd()}\n` +
            `└─ ggsql-cli ▸ ${oneLine(query)}  → ${result}`
        );
        logDebug(
            `run #${runNumber} full query:\n── ggsql-cli ──\n${query}` +
            (fullError ? `\n✕ ${fullError}` : '')
        );
    };

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
                        logCliRun('cancelled', '✕ cancelled');
                        reject(new QueryCancelledError('The query was cancelled.'));
                        return;
                    }
                    const errnoError = error as NodeJS.ErrnoException;
                    if (errnoError.code === 'ENOENT') {
                        logCliRun('failed', `✕ '${executable}' not found`);
                        reject(new GgsqlError(
                            `Could not find '${executable}'. Install the ggsql CLI or set "ggsql.executablePath" in settings.`
                        ));
                        return;
                    }
                    const message = stderr.trim() || error.message;
                    logCliRun('failed', `✕ ${oneLine(message, 120)}`, message);
                    reject(new GgsqlError(message));
                    return;
                }

                try {
                    const specs = parseJsonDocuments(stdout);
                    if (specs.length === 0) {
                        logCliRun('failed', '✕ no visualization output');
                        reject(new GgsqlError(
                            stderr.trim() || 'ggsql produced no visualization output.'
                        ));
                        return;
                    }
                    logCliRun('ok', `${specs.length} spec${specs.length === 1 ? '' : 's'}`);
                    resolve({ specs, stderr: stderr.trim() });
                } catch (e) {
                    logCliRun('failed', '✕ unparseable output');
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
