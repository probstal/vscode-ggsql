import * as vscode from 'vscode';

/*
 * Log output channel. Entries are timestamped by the channel itself, and
 * the user picks the verbosity per channel (gear icon in the Output
 * panel, or the "Developer: Set Log Level..." command). Run trees log at
 * info with queries collapsed to one line; the full untruncated queries
 * follow at debug level.
 */
export const outputChannel = vscode.window.createOutputChannel('ggsql', { log: true });

export function log(message: string): void {
    outputChannel.info(message);
}

/** Log a preformatted (possibly multi-line) block, e.g. a run tree. */
export function logRaw(text: string): void {
    outputChannel.info(text);
}

/** Untruncated details, hidden until the channel's log level is Debug. */
export function logDebug(text: string): void {
    outputChannel.debug(text);
}

/** Collapse whitespace and truncate, for quoting queries in log lines. */
export function oneLine(text: string, max = 100): string {
    const collapsed = text.replace(/\s+/g, ' ').trim();
    return collapsed.length > max ? collapsed.slice(0, max - 1) + '…' : collapsed;
}

export function formatMs(ms: number): string {
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** Sequential run number, shared by all engines, to correlate log trees. */
let runCounter = 0;
export function nextRunNumber(): number {
    return ++runCounter;
}
