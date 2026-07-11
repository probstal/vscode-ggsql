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
import { runQuery, workingDirFor, GgsqlError, QueryCancelledError } from './runner';
import { initTreeSplit, planSplit } from './treeSplit';
import { findDbtProjectRoot, runDbtShow, writeRowsCache } from './dbt';
import { disposeStandalone } from './standalone';
import { GgsqlResultPanel } from './panel';
import { formatMs, log, logDebug, logRaw, oneLine, outputChannel } from './logging';

/**
 * Default file name (without extension) for saving charts produced by a
 * document: the file name with its ggsql/sql extensions stripped.
 */
function chartBaseName(document: vscode.TextDocument): string {
    const base = path.basename(document.uri.path);
    return base.replace(/(\.(ggsql|gsql|sql))+$/i, '') || 'chart';
}

/**
 * The one in-flight run. Starting a new run aborts the previous one, so
 * there is only ever a single active query.
 */
let activeRun: AbortController | undefined;

function startRun(): AbortController {
    activeRun?.abort();
    const controller = new AbortController();
    activeRun = controller;
    return controller;
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
    const controller = startRun();

    GgsqlResultPanel.setLoading(true);
    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Running ggsql query...',
                cancellable: true,
            },
            async (_progress, token) => {
                token.onCancellationRequested(() => controller.abort());
                const specs: object[] = [];
                for (const query of queries) {
                    const result = await runQuery(query, { cwd, signal: controller.signal });
                    specs.push(...result.specs);
                    if (result.stderr) {
                        log(result.stderr);
                    }
                }
                if (controller.signal.aborted) {
                    return;
                }
                if (specs.length > 0) {
                    // Rendering the new charts clears the loading overlay.
                    GgsqlResultPanel.show(
                        extensionUri, specs, chartBaseName(document), path.basename(document.uri.path)
                    );
                } else {
                    GgsqlResultPanel.setLoading(false);
                }
            }
        );
    } catch (e) {
        handleRunFailure(e, controller);
    } finally {
        if (activeRun === controller) {
            activeRun = undefined;
        }
    }
}

/**
 * Surface a failed run. Cancellation is silent: the loading overlay is
 * cleared (the old charts come back) unless a newer run has already taken
 * over the overlay. Real errors go to the results panel's overlay if one
 * is open (spinner becomes the error message), otherwise a notification.
 */
function handleRunFailure(e: unknown, controller: AbortController): void {
    if (e instanceof QueryCancelledError || controller.signal.aborted) {
        if (activeRun === controller) {
            GgsqlResultPanel.setLoading(false);
        }
        return;
    }
    const message = e instanceof GgsqlError ? e.message : String(e);
    log(`Query failed: ${message}`);
    if (!GgsqlResultPanel.showError(message)) {
        outputChannel.show(true);
        void vscode.window.showErrorMessage(`ggsql: ${message}`);
    }
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
        await initTreeSplit(__dirname);
        const split = planSplit(document.getText());
        if (split.fallback) {
            log(`dbt split: falling back to scanner (${split.fallback})`);
        }
        plan = split.plan;
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

    const controller = startRun();

    GgsqlResultPanel.setLoading(true);
    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Running dbt query...',
                cancellable: true,
            },
            async (_progress, token) => {
                token.onCancellationRequested(() => controller.abort());
                const dbtStartedAt = Date.now();
                const rows = await runDbtShow(plan.sql, projectRoot, controller.signal);
                logRaw(
                    `dbt · ${path.basename(document.uri.fsPath)} · project: ${projectRoot}\n` +
                    `└─ dbt ▸ dbt show --inline ${oneLine(plan.sql)}  → ${rows.length} rows · ${formatMs(Date.now() - dbtStartedAt)} · handing off to renderer ↓`
                );
                logDebug(`dbt full query:\n── dbt show --inline ──\n${plan.sql}`);
                if (rows.length === 0) {
                    throw new GgsqlError('The dbt query returned no rows.');
                }
                const cachePath = await writeRowsCache(rows, context.globalStorageUri);
                const query = plan.buildRenderQuery(cachePath);
                // The rows sit in the local JSON cache file, which both
                // engines read themselves: duckdb-wasm directly (standalone),
                // the CLI via in-memory duckdb (any custom ggsql.reader is
                // deliberately ignored on this path).
                const result = await runQuery(query, {
                    cwd: projectRoot,
                    reader: 'duckdb://memory',
                    signal: controller.signal,
                });
                if (result.stderr) {
                    log(result.stderr);
                }
                if (controller.signal.aborted) {
                    return;
                }
                GgsqlResultPanel.show(
                    context.extensionUri, result.specs, chartBaseName(document), path.basename(document.uri.path)
                );
            }
        );
    } catch (e) {
        handleRunFailure(e, controller);
    } finally {
        if (activeRun === controller) {
            activeRun = undefined;
        }
    }
}

/**
 * Activates the extension.
 *
 * @param context The extension context
 */
export function activate(context: vscode.ExtensionContext): void {
    log('ggsql extension activating...');

    // Warm up the tree-sitter split grammar (used by the dbt path; the
    // standalone worker loads its own copy).
    void initTreeSplit(__dirname);

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
    disposeStandalone();
}
