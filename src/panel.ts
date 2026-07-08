/*
 * Results panel: a webview beside the editor that renders Vega-Lite specs
 * produced by the ggsql CLI. The rendering itself happens in the webview
 * bundle (src/webview/main.ts), which embeds vega and vega-lite.
 */

import * as vscode from 'vscode';

export class GgsqlResultPanel {
    private static current: GgsqlResultPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private ready = false;
    private pendingSpecs: object[] | undefined;
    private disposables: vscode.Disposable[] = [];

    static show(extensionUri: vscode.Uri, specs: object[]): void {
        if (GgsqlResultPanel.current) {
            GgsqlResultPanel.current.render(specs);
            GgsqlResultPanel.current.panel.reveal(undefined, true);
            return;
        }
        GgsqlResultPanel.current = new GgsqlResultPanel(extensionUri, specs);
    }

    private constructor(extensionUri: vscode.Uri, specs: object[]) {
        this.pendingSpecs = specs;

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

    private render(specs: object[]): void {
        this.pendingSpecs = specs;
        this.flush();
    }

    private flush(): void {
        if (this.ready && this.pendingSpecs) {
            this.panel.webview.postMessage({ type: 'render', specs: this.pendingSpecs });
            this.pendingSpecs = undefined;
        }
    }

    private dispose(): void {
        GgsqlResultPanel.current = undefined;
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables = [];
    }
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
