import * as vscode from 'vscode';

// Output channel for logging
export const outputChannel = vscode.window.createOutputChannel('ggsql');

export function log(message: string): void {
    outputChannel.appendLine(`[${timestamp()}] ${message}`);
}

/** Append preformatted (possibly multi-line) text, e.g. a run tree. */
export function logRaw(text: string): void {
    outputChannel.appendLine(text);
}

/** HH:MM:SS.mmm — every run-tree line carries one. */
export function timestamp(): string {
    const d = new Date();
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
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
