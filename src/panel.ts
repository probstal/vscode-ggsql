/*
 * Results panel: a webview beside the editor that renders Vega-Lite specs
 * produced by the ggsql CLI. The rendering itself happens in the webview
 * bundle (src/webview/main.ts), which embeds vega and vega-lite.
 */

import * as vscode from 'vscode';

type ExportFormat = 'svg' | 'png' | 'json';

interface ExportResultMessage {
    type: 'exportResult';
    id: number;
    images?: string[];
    error?: string;
}

export class GgsqlResultPanel {
    private static current: GgsqlResultPanel | undefined;
    /** Directory of the last saved chart; the next save dialog reopens there
     *  (in-memory only, reset when the window reloads). */
    private static lastSaveDir: vscode.Uri | undefined;

    private readonly panel: vscode.WebviewPanel;
    private ready = false;
    private pendingSpecs: object[] | undefined;
    private specs: object[] = [];
    private baseName = 'chart';
    private disposables: vscode.Disposable[] = [];
    private exportSeq = 0;
    private pendingExports = new Map<number, {
        resolve: (images: string[]) => void;
        reject: (error: Error) => void;
    }>();

    static show(extensionUri: vscode.Uri, specs: object[], baseName?: string): void {
        if (GgsqlResultPanel.current) {
            GgsqlResultPanel.current.render(specs, baseName);
            GgsqlResultPanel.current.panel.reveal(undefined, true);
            return;
        }
        GgsqlResultPanel.current = new GgsqlResultPanel(extensionUri, specs, baseName);
    }

    /**
     * Save the currently rendered charts to disk in the given format,
     * prompting for the target file. With multiple charts, the chosen name
     * gets a -2, -3, ... suffix for each additional chart.
     */
    static async saveCharts(format: ExportFormat): Promise<void> {
        const current = GgsqlResultPanel.current;
        if (!current || !current.ready) {
            void vscode.window.showErrorMessage('ggsql: No rendered charts to save.');
            return;
        }

        // The Vega-Lite specs are already in the extension host; only image
        // formats need the webview (where the rendered vega views live).
        let images: string[];
        if (format === 'json') {
            images = current.specs.map(spec => JSON.stringify(spec, null, 2));
        } else {
            try {
                images = await current.requestExport(format);
            } catch (e) {
                void vscode.window.showErrorMessage(
                    `ggsql: Failed to export charts: ${e instanceof Error ? e.message : e}`
                );
                return;
            }
        }
        if (images.length === 0) {
            void vscode.window.showErrorMessage('ggsql: No rendered charts to save.');
            return;
        }

        const dir = GgsqlResultPanel.lastSaveDir ?? vscode.workspace.workspaceFolders?.[0]?.uri;
        const fileName = format === 'json' ? `${current.baseName}.vl.json` : `${current.baseName}.${format}`;
        const target = await vscode.window.showSaveDialog({
            filters: {
                svg: { 'SVG image': ['svg'] },
                png: { 'PNG image': ['png'] },
                json: { 'Vega-Lite JSON': ['json'] },
            }[format],
            defaultUri: dir ? vscode.Uri.joinPath(dir, fileName) : undefined,
        });
        if (!target) {
            return;
        }
        GgsqlResultPanel.lastSaveDir = vscode.Uri.joinPath(target, '..');

        const saved: string[] = [];
        for (let i = 0; i < images.length; i++) {
            const uri = i === 0 ? target : withNumberSuffix(target, i + 1);
            const data = format === 'png'
                ? Buffer.from(images[i].replace(/^data:image\/png;base64,/, ''), 'base64')
                : Buffer.from(images[i], 'utf8');
            await vscode.workspace.fs.writeFile(uri, data);
            saved.push(uri.fsPath);
        }
        void vscode.window.showInformationMessage(
            saved.length === 1
                ? `ggsql: Chart saved to ${saved[0]}`
                : `ggsql: ${saved.length} charts saved to ${saved.join(', ')}`
        );
    }

    /** Ask the webview to export all charts and await its response. */
    private requestExport(format: ExportFormat): Promise<string[]> {
        const id = ++this.exportSeq;
        return new Promise<string[]>((resolve, reject) => {
            this.pendingExports.set(id, { resolve, reject });
            setTimeout(() => {
                if (this.pendingExports.delete(id)) {
                    reject(new Error('The results panel did not respond.'));
                }
            }, 10_000);
            void this.panel.webview.postMessage({ type: 'export', format, id });
        });
    }

    private constructor(extensionUri: vscode.Uri, specs: object[], baseName?: string) {
        this.pendingSpecs = specs;
        this.specs = specs;
        this.baseName = baseName ?? 'chart';

        this.panel = vscode.window.createWebviewPanel(
            'ggsqlResults',
            'ggsql Results',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out')],
            }
        );
        this.panel.iconPath = vscode.Uri.joinPath(extensionUri, 'logo.png');

        this.panel.webview.onDidReceiveMessage(
            (message: { type: string }) => {
                if (message.type === 'ready') {
                    this.ready = true;
                    this.flush();
                } else if (message.type === 'exportResult') {
                    this.resolveExport(message as ExportResultMessage);
                }
            },
            undefined,
            this.disposables
        );

        this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);

        const scriptUri = this.panel.webview.asWebviewUri(
            vscode.Uri.joinPath(extensionUri, 'out', 'webview.js')
        );
        this.panel.webview.html = getHtml(this.panel.webview, scriptUri);
    }

    private render(specs: object[], baseName?: string): void {
        this.pendingSpecs = specs;
        this.specs = specs;
        this.baseName = baseName ?? 'chart';
        this.flush();
    }

    private flush(): void {
        if (this.ready && this.pendingSpecs) {
            this.panel.webview.postMessage({ type: 'render', specs: this.pendingSpecs });
            this.pendingSpecs = undefined;
        }
    }

    private resolveExport(message: ExportResultMessage): void {
        const pending = this.pendingExports.get(message.id);
        if (!pending) {
            return;
        }
        this.pendingExports.delete(message.id);
        if (message.error !== undefined || !message.images) {
            pending.reject(new Error(message.error ?? 'The results panel returned no images.'));
        } else {
            pending.resolve(message.images);
        }
    }

    private dispose(): void {
        GgsqlResultPanel.current = undefined;
        for (const pending of this.pendingExports.values()) {
            pending.reject(new Error('The results panel was closed.'));
        }
        this.pendingExports.clear();
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables = [];
    }
}

/** chart.svg → chart-2.svg for saving additional charts alongside. */
function withNumberSuffix(uri: vscode.Uri, n: number): vscode.Uri {
    const dot = uri.path.lastIndexOf('.');
    const slash = uri.path.lastIndexOf('/');
    if (dot > slash) {
        return uri.with({ path: `${uri.path.slice(0, dot)}-${n}${uri.path.slice(dot)}` });
    }
    return uri.with({ path: `${uri.path}-${n}` });
}

function getHtml(webview: vscode.Webview, scriptUri: vscode.Uri): string {
    const csp = [
        "default-src 'none'",
        `script-src ${webview.cspSource}`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `img-src ${webview.cspSource} data:`,
        `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ggsql Results</title>
    <style>
        /* The whole chain needs definite heights: .chart-body resolves its
           percentage height against .chart, which is only definite when the
           flex container (#charts) itself has a definite height. */
        html, body {
            height: 100%;
        }
        body {
            margin: 0;
            padding: 0;
            font-family: var(--vscode-font-family);
        }
        #charts {
            display: flex;
            flex-direction: column;
            gap: 12px;
            height: 100%;
            padding: 12px;
            box-sizing: border-box;
            overflow-y: auto;
        }
        /* Cards split the panel height evenly; with many charts they stop
           shrinking at 300px and #charts scrolls instead. */
        .chart {
            flex: 1 1 0;
            min-height: 300px;
            background: #ffffff;
            border-radius: 4px;
            padding: 12px;
            box-sizing: border-box;
            overflow: hidden;
        }
        .chart-body {
            width: 100%;
            height: 100%;
        }
        .render-error {
            flex: initial;
            min-height: 0;
            color: var(--vscode-errorForeground);
            white-space: pre-wrap;
            font-family: var(--vscode-editor-font-family);
            background: transparent;
        }
    </style>
</head>
<body>
    <div id="charts"></div>
    <script src="${scriptUri}"></script>
</body>
</html>`;
}
