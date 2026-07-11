/*
 * Worker thread hosting the standalone engine: duckdb-wasm executes the
 * SQL, ggsql-wasm renders the VISUALISE part.
 *
 * Per statement (split at top-level semicolons) the flow is the same as
 * the dbt path: split at VISUALISE (querySplit.ts), run the SQL on
 * duckdb, hand the result to ggsql as a parquet table, execute the
 * rewritten VISUALISE query. duckdb-wasm's NODE_FS runtime reads files
 * referenced in queries (CSV/JSON/Parquet/globs) straight from disk; a
 * wrapper resolves relative paths against the run's cwd (the document's
 * folder), since the wasm has no working directory of its own.
 *
 * Both engines' execute calls are synchronous, so they run here instead
 * of on the extension host: long queries don't freeze VS Code, and
 * cancellation is worker.terminate() (see standalone.ts, which owns this
 * worker). Engine state (duckdb catalog, ggsql tables) persists across
 * runs until a cancel or window reload.
 *
 * Bundled separately to out/wasmWorker.js; the wasm binaries are copied
 * to out/ by esbuild.js.
 */

import { parentPort, threadId } from 'worker_threads';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initSync, GgsqlContext } from 'ggsql-wasm';
import * as duckdb from '@duckdb/duckdb-wasm/blocking';
import { splitStatements } from './querySplit';
import { initTreeSplit, planSplit } from './treeSplit';
import { GgsqlError } from './errors';

export interface WorkerRequest {
    id: number;
    query: string;
    /** Base directory for relative file references in the query */
    cwd?: string;
}

export interface TraceStep {
    engine: 'duckdb' | 'ggsql';
    query: string;
    ms: number;
    /** Row count (duckdb steps) */
    rows?: number;
    /** Produced spec count (ggsql steps) */
    specs?: number;
    /** Why this step took an unusual route (fallbacks, ggsql: datasets) */
    note?: string;
    error?: string;
}

export interface StatementTrace {
    index: number;
    total: number;
    steps: TraceStep[];
}

export interface WorkerResponse {
    id: number;
    ok: boolean;
    /** Vega-Lite specs as JSON strings */
    specs?: string[];
    error?: string;
    trace: StatementTrace[];
}

if (!parentPort) {
    throw new Error('wasmWorker must run as a worker thread');
}
const port = parentPort;

/** ggsql-side table name the duckdb result is registered under. */
const BRIDGE_TABLE = 'duckdb_result';

/** Base dir for resolving relative paths, set per request. */
let baseDir = process.cwd();

// Grammar-based VISUALISE splitting (falls back to the scanner in
// querySplit.ts until loaded, or on parse errors).
const treeSplitReady = initTreeSplit(__dirname);

// ---------------------------------------------------------------- ggsql

let ggsql: GgsqlContext | undefined;
let ggsqlBuiltins: Promise<void> | undefined;
let ggsqlBuiltinsError: string | undefined;

function getGgsql(): GgsqlContext {
    if (!ggsql) {
        initSync({ module: fs.readFileSync(path.join(__dirname, 'ggsql_wasm_bg.wasm')) });
        ggsql = new GgsqlContext();
        // ggsql:penguins and friends; best effort (may hit the network).
        ggsqlBuiltins = ggsql.register_builtin_datasets().catch(e => {
            ggsqlBuiltinsError = e instanceof Error ? e.message : String(e);
        });
    }
    return ggsql;
}

// --------------------------------------------------------------- duckdb

interface DuckDBHandle {
    bindings: Awaited<ReturnType<typeof duckdb.createDuckDB>>;
    connection: ReturnType<Awaited<ReturnType<typeof duckdb.createDuckDB>>['connect']>;
}

let duck: Promise<DuckDBHandle> | undefined;

/**
 * duckdb-wasm requests every file through its runtime; the stock Node
 * runtime resolves relative paths against process.cwd(). Wrap the two
 * path-based hooks (all reads funnel through glob, existence checks
 * through checkFile) to resolve against the run's base dir instead.
 */
function makeRuntime(): duckdb.DuckDBRuntime {
    type PathHook = (mod: never, pathPtr: number, pathLen: number) => unknown;
    const nodeRuntime = duckdb.NODE_RUNTIME as unknown as Record<string, PathHook>;
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    const withResolvedPath = (hook: 'glob' | 'checkFile') =>
        (mod: never, pathPtr: number, pathLen: number): unknown => {
            const emscripten = mod as {
                HEAPU8: Uint8Array;
                _malloc(size: number): number;
                _free(ptr: number): void;
            };
            const raw = decoder.decode(emscripten.HEAPU8.subarray(pathPtr, pathPtr + pathLen));
            if (path.isAbsolute(raw) || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
                return nodeRuntime[hook](mod, pathPtr, pathLen);
            }
            const bytes = encoder.encode(path.resolve(baseDir, raw));
            const buffer = emscripten._malloc(bytes.length);
            emscripten.HEAPU8.set(bytes, buffer);
            try {
                return nodeRuntime[hook](mod, buffer as never, bytes.length);
            } finally {
                emscripten._free(buffer);
            }
        };

    return {
        ...duckdb.NODE_RUNTIME,
        glob: withResolvedPath('glob') as typeof duckdb.NODE_RUNTIME.glob,
        checkFile: withResolvedPath('checkFile') as typeof duckdb.NODE_RUNTIME.checkFile,
    };
}

function getDuckdb(): Promise<DuckDBHandle> {
    if (!duck) {
        duck = (async () => {
            const wasmPath = path.join(__dirname, 'duckdb-eh.wasm');
            // mainWorker is unused by the blocking Node bindings but
            // required by the bundle type.
            const bundle = { mainModule: wasmPath, mainWorker: '' };
            const bindings = await duckdb.createDuckDB(
                { mvp: bundle, eh: bundle },
                new duckdb.VoidLogger(),
                makeRuntime(),
            );
            await bindings.instantiate(() => {});
            return { bindings, connection: bindings.connect() };
        })();
    }
    return duck;
}

// ---------------------------------------------------------------- steps

/** 'Execute error: ReaderError("no such table: x")' → 'no such table: x' */
function cleanErrorMessage(raw: string): string {
    let message = raw.replace(/^\w+ error: /, '');
    const wrapped = /^\w+\("([\s\S]*)"\)$/.exec(message);
    if (wrapped) {
        message = wrapped[1].replace(/\\"/g, '"');
    }
    return message;
}

/** Record a failed step and return the error to throw for the run. */
function stepError(
    steps: TraceStep[],
    step: Omit<TraceStep, 'ms' | 'error'>,
    startedAt: number,
    e: unknown,
): GgsqlError {
    const message = cleanErrorMessage(e instanceof Error ? e.message : String(e));
    steps.push({ ...step, ms: Date.now() - startedAt, error: message });
    return new GgsqlError(`${step.engine === 'duckdb' ? 'DuckDB' : 'ggsql'}: ${message}`);
}

/** Run a whole statement through ggsql-wasm (no duckdb involved). */
function runOnGgsqlDirect(statement: string, steps: TraceStep[], note: string): string {
    const context = getGgsql();
    const startedAt = Date.now();
    try {
        const spec = context.execute(statement);
        steps.push({ engine: 'ggsql', query: statement, ms: Date.now() - startedAt, specs: 1, note });
        return spec;
    } catch (e) {
        throw stepError(steps, { engine: 'ggsql', query: statement, note }, startedAt, e);
    }
}

/**
 * Execute one statement, appending trace steps, and return its specs.
 */
async function runStatement(statement: string, steps: TraceStep[]): Promise<string[]> {
    const context = getGgsql();
    await ggsqlBuiltins;

    // Builtin datasets only exist inside the ggsql context (note: the
    // engine resolves them unquoted, FROM ggsql:penguins).
    if (/\bfrom\s+["']?ggsql:/i.test(statement)) {
        const note = ggsqlBuiltinsError
            ? `ggsql: dataset, skipping duckdb; builtin registration failed: ${ggsqlBuiltinsError}`
            : 'ggsql: dataset, skipping duckdb';
        return [runOnGgsqlDirect(statement, steps, note)];
    }

    const { plan, fallback } = planSplit(statement);
    const splitNote = fallback && `split via scanner: ${fallback}`;

    if (!plan) {
        if (context.has_visual(statement)) {
            // The splitter missed the VISUALISE the real parser sees; let
            // ggsql handle the whole statement rather than mangling it.
            return [runOnGgsqlDirect(statement, steps, 'fallback: splitter missed VISUALISE')];
        }
        // Plain SQL (CREATE TABLE, INSERT, bare SELECT, ...) — side
        // effects live in the duckdb catalog for later statements.
        const { connection } = await getDuckdb();
        const startedAt = Date.now();
        try {
            const table = connection.query(statement);
            steps.push({ engine: 'duckdb', query: statement, ms: Date.now() - startedAt, rows: table.numRows, note: splitNote });
            return [];
        } catch (e) {
            throw stepError(steps, { engine: 'duckdb', query: statement, note: splitNote }, startedAt, e);
        }
    }

    if (!context.has_visual(statement)) {
        // Scanner found VISUALISE but the parser disagrees (e.g. inside an
        // unusual construct) — treat as plain SQL.
        const { connection } = await getDuckdb();
        const startedAt = Date.now();
        const note = 'ggsql parser sees no VISUALISE, running as plain SQL';
        try {
            const table = connection.query(statement);
            steps.push({ engine: 'duckdb', query: statement, ms: Date.now() - startedAt, rows: table.numRows, note });
            return [];
        } catch (e) {
            throw stepError(steps, { engine: 'duckdb', query: statement, note }, startedAt, e);
        }
    }

    // Split pipeline: SQL on duckdb → parquet hand-off → ggsql renders.
    const { connection } = await getDuckdb();
    const bridgeFile = path.join(os.tmpdir(), `ggsql-bridge-${process.pid}-${threadId}.parquet`);
    let rows = 0;

    const sqlStartedAt = Date.now();
    try {
        // A stale file (e.g. from a run cancelled mid-COPY) must go first:
        // duckdb opens without truncating, which would corrupt the footer.
        fs.rmSync(bridgeFile, { force: true });
        const copyResult = connection.query(
            `COPY (${plan.sql}) TO '${bridgeFile.replace(/'/g, "''")}' (FORMAT parquet)`
        );
        rows = Number(copyResult.toArray()[0]?.Count ?? 0);
        steps.push({ engine: 'duckdb', query: plan.sql, ms: Date.now() - sqlStartedAt, rows, note: splitNote });
    } catch (e) {
        throw stepError(steps, { engine: 'duckdb', query: plan.sql, note: splitNote }, sqlStartedAt, e);
    }

    const renderQuery = plan.buildRenderQuery(BRIDGE_TABLE);
    const renderStartedAt = Date.now();
    try {
        const bytes = fs.readFileSync(bridgeFile);
        try {
            context.unregister(BRIDGE_TABLE);
        } catch {
            // not registered yet
        }
        await context.register_parquet(BRIDGE_TABLE, bytes);
        const spec = context.execute(renderQuery);
        steps.push({ engine: 'ggsql', query: renderQuery, ms: Date.now() - renderStartedAt, specs: 1 });
        return [spec];
    } catch (e) {
        throw stepError(steps, { engine: 'ggsql', query: renderQuery }, renderStartedAt, e);
    } finally {
        fs.rmSync(bridgeFile, { force: true });
    }
}

async function handle(request: WorkerRequest): Promise<void> {
    baseDir = request.cwd ?? process.cwd();
    const trace: StatementTrace[] = [];
    try {
        await treeSplitReady;
        const statements = splitStatements(request.query);
        const specs: string[] = [];
        for (let i = 0; i < statements.length; i++) {
            const entry: StatementTrace = { index: i + 1, total: statements.length, steps: [] };
            trace.push(entry);
            specs.push(...await runStatement(statements[i], entry.steps));
        }
        port.postMessage({ id: request.id, ok: true, specs, trace } satisfies WorkerResponse);
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        port.postMessage({ id: request.id, ok: false, error: message, trace } satisfies WorkerResponse);
    }
}

port.on('message', (request: WorkerRequest) => {
    void handle(request);
});
