/*
 * ggsql VS Code Extension
 *
 * Provides syntax highlighting for ggsql and runs queries through the
 * ggsql CLI, rendering the resulting Vega-Lite specs in a webview panel.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { GgsqlCodeLensProvider, registerCellCommands } from './codelens';
import { activateDecorations } from './decorations';
import { activateContextKeys } from './context';
import { parseCells } from './cellParser';
import { runQuery, workingDirFor, GgsqlError } from './runner';
import { findDbtProjectRoot, planDbtQuery, runDbtShow, writeRowsCache } from './dbt';
import { GgsqlResultPanel } from './panel';
import { log, outputChannel } from './logging';

/**
 * Default file name (without extension) for saving charts produced by a
 * document: the file name with its ggsql/sql extensions stripped.
 */
function chartBaseName(document: vscode.TextDocument): string {
    const base = path.basename(document.uri.path);
    return base.replace(/(\.(ggsql|gsql|sql))+$/i, '') || 'chart';
}

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
                GgsqlResultPanel.show(extensionUri, specs, chartBaseName(document));
            }
        }
    );
}

/**
 * Run a dbt-project file containing a VISUALISE clause: the SQL part is
 * compiled and executed by the dbt CLI against the project's target, the
 * rows are cached to a local JSON file, and ggsql renders the VISUALISE
 * part from that file via its duckdb reader.
 */
async function runDbtVisualisation(
    context: vscode.ExtensionContext,
    document: vscode.TextDocument,
): Promise<void> {
    if (document.uri.scheme !== 'file') {
        void vscode.window.showErrorMessage('ggsql: Save the file to disk before running it with dbt.');
        return;
    }
    let plan;
    try {
        plan = planDbtQuery(document.getText());
    } catch (e) {
        const message = e instanceof GgsqlError ? e.message : String(e);
        void vscode.window.showErrorMessage(`ggsql: ${message}`);
        return;
    }
    if (!plan) {
        void vscode.window.showErrorMessage('ggsql: No VISUALISE clause found in this file.');
        return;
    }
    const projectRoot = findDbtProjectRoot(path.dirname(document.uri.fsPath));
    if (!projectRoot) {
        void vscode.window.showErrorMessage('ggsql: No dbt_project.yml found above this file.');
        return;
    }

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Window,
            title: 'Running dbt query...',
        },
        async () => {
            try {
                const rows = await runDbtShow(plan.dbtSql, projectRoot);
                if (rows.length === 0) {
                    throw new GgsqlError('The dbt query returned no rows.');
                }
                const cachePath = await writeRowsCache(rows, context.globalStorageUri);
                log(`Cached ${rows.length} rows to ${cachePath}`);
                const query = plan.buildRenderQuery(cachePath);
                // The data already sits in the local cache file, so ignore
                // any custom ggsql.reader and read it with in-memory duckdb.
                const result = await runQuery(query, projectRoot, 'duckdb://memory');
                if (result.stderr) {
                    log(result.stderr);
                }
                GgsqlResultPanel.show(context.extensionUri, result.specs, chartBaseName(document));
            } catch (e) {
                const message = e instanceof GgsqlError ? e.message : String(e);
                log(`dbt visualization failed: ${message}`);
                outputChannel.show(true);
                void vscode.window.showErrorMessage(`ggsql: ${message}`);
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

    // "Render ggsql Visualization" for sql/jinja-sql files inside a dbt
    // project (shown when the file contains a VISUALISE clause).
    context.subscriptions.push(
        vscode.commands.registerCommand('ggsql.renderDbtFile', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                return;
            }
            void runDbtVisualisation(context, editor.document);
        })
    );

    // Save the rendered charts to disk (shown in the results panel's
    // editor-title overflow menu).
    context.subscriptions.push(
        vscode.commands.registerCommand('ggsql.saveChartAsSvg', () =>
            GgsqlResultPanel.saveCharts('svg')
        ),
        vscode.commands.registerCommand('ggsql.saveChartAsPng', () =>
            GgsqlResultPanel.saveCharts('png')
        ),
        vscode.commands.registerCommand('ggsql.saveChartAsJson', () =>
            GgsqlResultPanel.saveCharts('json')
        ),
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
