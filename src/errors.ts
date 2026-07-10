/*
 * Shared error types. Kept free of vscode imports so worker-thread code
 * (wasmWorker.ts) can use them too; runner.ts re-exports them for the
 * extension-host modules.
 */

export class GgsqlError extends Error {}

/** The run was aborted (user cancel or superseded by a newer run). */
export class QueryCancelledError extends Error {}
