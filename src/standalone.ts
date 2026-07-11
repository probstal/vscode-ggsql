/*
 * Standalone engine: runs queries without the ggsql CLI, in a worker
 * thread (wasmWorker.ts) that hosts duckdb-wasm for the SQL and
 * ggsql-wasm for the VISUALISE rendering. This module owns the worker:
 * request/response plumbing, cancellation (terminate + fresh worker on
 * the next run), and the run-tree logging.
 */

import * as path from 'path';
import { Worker } from 'worker_threads';
import { GgsqlError, QueryCancelledError } from './errors';
import type { RunOptions, RunResult } from './runner';
import type { StatementTrace, WorkerRequest, WorkerResponse } from './wasmWorker';
import { formatMs, log, logDebug, logRaw, nextRunNumber, oneLine } from './logging';

let worker: Worker | undefined;
let requestSeq = 0;
const pending = new Map<number, {
    resolve: (response: WorkerResponse) => void;
    reject: (error: Error) => void;
}>();

function failAllPending(error: Error): void {
    for (const request of pending.values()) {
        request.reject(error);
    }
    pending.clear();
}

function getWorker(): Worker {
    if (!worker) {
        const created = new Worker(path.join(__dirname, 'wasmWorker.js'));
        worker = created;
        created.on('message', (response: WorkerResponse) => {
            const request = pending.get(response.id);
            if (!request) {
                return;
            }
            pending.delete(response.id);
            request.resolve(response);
        });
        created.on('error', error => {
            failAllPending(new GgsqlError(`The standalone engine crashed: ${error.message}`));
            if (worker === created) {
                worker = undefined;
            }
        });
        created.on('exit', () => {
            failAllPending(new GgsqlError('The standalone engine stopped unexpectedly.'));
            if (worker === created) {
                worker = undefined;
            }
        });
    }
    return worker;
}

function terminateWorker(): void {
    const current = worker;
    worker = undefined;
    if (current) {
        current.removeAllListeners();
        void current.terminate();
    }
}

/** Shut down the engine worker (extension deactivation). */
export function disposeStandalone(): void {
    failAllPending(new QueryCancelledError('The extension is shutting down.'));
    terminateWorker();
}

/**
 * Format a run's trace as a tree, one line per engine step:
 *
 * run #3 · standalone · ok · 45ms · cwd: /Users/x/proj
 * ├─ statement 1/2
 * │  ├─ duckdb ▸ SELECT city, temp FROM 'weather.csv'  → 365 rows · 12ms
 * │  └─ ggsql ▸ SELECT * FROM 'duckdb_result' VISUALISE …  → 1 spec · 4ms
 * └─ statement 2/2
 *    └─ duckdb ▸ CREATE TABLE t AS …  → 0 rows · 3ms
 */
function formatTrace(
    runNumber: number,
    cwd: string | undefined,
    trace: StatementTrace[],
    totalMs: number,
    outcome: string,
): string {
    const lines = [
        `run #${runNumber} · standalone · ${outcome} · ${formatMs(totalMs)} · cwd: ${cwd ?? process.cwd()}`,
    ];
    const single = trace.length === 1;
    trace.forEach((statement, i) => {
        const lastStatement = i === trace.length - 1;
        let indent = '';
        if (!single) {
            lines.push(`${lastStatement ? '└─' : '├─'} statement ${statement.index}/${statement.total}`);
            indent = lastStatement ? '   ' : '│  ';
        }
        statement.steps.forEach((step, j) => {
            const branch = j === statement.steps.length - 1 ? '└─' : '├─';
            const result = step.error !== undefined
                ? `✕ ${oneLine(step.error, 120)}`
                : step.specs !== undefined
                    ? `${step.specs} spec${step.specs === 1 ? '' : 's'}`
                    : `${step.rows ?? 0} rows`;
            const note = step.note ? `  (${step.note})` : '';
            lines.push(`${indent}${branch} ${step.engine} ▸ ${oneLine(step.query)}  → ${result} · ${formatMs(step.ms)}${note}`);
        });
    });
    return lines.join('\n');
}

/**
 * Debug-level companion to the run tree: every step's query (and error)
 * untruncated, for inspecting what exactly each engine received.
 */
function formatFullQueries(runNumber: number, trace: StatementTrace[]): string {
    const single = trace.length === 1;
    const blocks: string[] = [];
    for (const statement of trace) {
        for (const step of statement.steps) {
            const heading = single
                ? step.engine
                : `statement ${statement.index}/${statement.total} · ${step.engine}`;
            const error = step.error !== undefined ? `\n✕ ${step.error}` : '';
            blocks.push(`── ${heading} ──\n${step.query}${error}`);
        }
    }
    return `run #${runNumber} full queries:\n${blocks.join('\n')}`;
}

/**
 * Execute a ggsql query with the standalone engine and return the
 * resulting Vega-Lite specs. Mirrors the CLI contract: rejects with
 * GgsqlError on failure and QueryCancelledError when options.signal
 * aborts (which terminates the worker mid-query).
 */
export async function runStandalone(query: string, options: RunOptions): Promise<RunResult> {
    if (options.signal?.aborted) {
        throw new QueryCancelledError('The query was cancelled.');
    }
    const runNumber = nextRunNumber();
    const startedAt = Date.now();
    log(`run #${runNumber} · standalone · started`);

    const id = ++requestSeq;
    let response: WorkerResponse;
    try {
        response = await new Promise<WorkerResponse>((resolve, reject) => {
            const onAbort = () => {
                if (pending.delete(id)) {
                    reject(new QueryCancelledError('The query was cancelled.'));
                }
                terminateWorker();
            };
            pending.set(id, {
                resolve: value => {
                    options.signal?.removeEventListener('abort', onAbort);
                    resolve(value);
                },
                reject: error => {
                    options.signal?.removeEventListener('abort', onAbort);
                    reject(error);
                },
            });
            options.signal?.addEventListener('abort', onAbort, { once: true });
            getWorker().postMessage({ id, query, cwd: options.cwd } satisfies WorkerRequest);
        });
    } catch (e) {
        if (e instanceof QueryCancelledError) {
            logRaw(`run #${runNumber} · standalone · cancelled after ${formatMs(Date.now() - startedAt)}`);
        }
        throw e;
    }

    logRaw(formatTrace(runNumber, options.cwd, response.trace, Date.now() - startedAt, response.ok ? 'ok' : 'failed'));
    if (response.trace.some(statement => statement.steps.length > 0)) {
        logDebug(formatFullQueries(runNumber, response.trace));
    }

    if (!response.ok || !response.specs) {
        throw new GgsqlError(response.error ?? 'The standalone engine returned no result.');
    }
    const specs = response.specs.map(spec => JSON.parse(spec) as object);
    if (specs.length === 0) {
        throw new GgsqlError('ggsql produced no visualization output.');
    }
    return { specs, stderr: '' };
}
