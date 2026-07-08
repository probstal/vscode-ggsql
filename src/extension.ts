/*
 * ggsql VS Code Extension
 *
 * Provides syntax highlighting for ggsql and runs queries through the
 * ggsql CLI, rendering the resulting Vega-Lite specs in a webview panel.
 */

import * as vscode from 'vscode';
import { GgsqlCodeLensProvider, registerCellCommands } from './codelens';
import { activateDecorations } from './decorations';
import { activateContextKeys } from './context';
import { parseCells } from './cellParser';
import { runQuery, workingDirFor, GgsqlError } from './runner';
import { GgsqlResultPanel } from './panel';
import { log, outputChannel } from './logging';

/**
 * Run one or more ggsql queries against the active document's working
 * directory and show the resulting visualizations in the results panel.
 */
async function executeQueries(
    extensionUri: vscode.Uri,
    document: vscode.TextDocument,
    queries: string[],
): Promise<void> {
    const cwd = workingDirFor(document);

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Window,
            title: 'Running ggsql query...',
        },
        async () => {
            const specs: object[] = [];
            for (const query of queries) {
                try {
                    const result = await runQuery(query, cwd);
                    specs.push(...result.specs);
                    if (result.stderr) {
                        log(result.stderr);
                    }
                } catch (e) {
                    const message = e instanceof GgsqlError ? e.message : String(e);
                    log(`Query failed: ${message}`);
                    outputChannel.show(true);
                    void vscode.window.showErrorMessage(`ggsql: ${message}`);
                    return;
                }
            }
            if (specs.length > 0) {
                GgsqlResultPanel.show(extensionUri, specs);
            }
        }
    );
}

/**
 * Activates the extension.
 *
 * @param context The extension context
 */
export function activate(context: vscode.ExtensionContext): void {
    log('ggsql extension activating...');

    const execute = (queries: string[]) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }
        void executeQueries(context.extensionUri, editor.document, queries);
    };

    // "Run File" command for the editor run button: executes the whole file
    // as a single ggsql query (a file can contain multiple statements).
    context.subscriptions.push(
        vscode.commands.registerCommand('ggsql.sourceCurrentFile', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== 'ggsql') {
                return;
            }
            const cells = parseCells(editor.document);
            if (cells.length > 0) {
                execute(cells.map(cell => cell.text).filter(text => text.length > 0));
            } else {
                const code = editor.document.getText();
                if (code.trim().length > 0) {
                    execute([code]);
                }
            }
        })
    );

    // Register code lens provider and cell commands
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider('ggsql', new GgsqlCodeLensProvider()),
    );
    registerCellCommands(context, execute);

    activateDecorations(context.subscriptions);
    activateContextKeys(context.subscriptions);

    log('ggsql extension activated');
}

/**
 * Deactivates the extension.
 */
export function deactivate(): void {
    // Nothing to clean up
}
