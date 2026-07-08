import * as vscode from 'vscode';

// Output channel for logging
export const outputChannel = vscode.window.createOutputChannel('ggsql');

export function log(message: string): void {
    outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
}
