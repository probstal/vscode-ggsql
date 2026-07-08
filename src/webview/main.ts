/*
 * Webview entry point: receives Vega-Lite specs from the extension host,
 * compiles them with vega-lite and renders them with vega.
 */

import * as vega from 'vega';
import { compile, type TopLevelSpec } from 'vega-lite';
// CSP-safe expression interpreter: webviews disallow eval/new Function,
// which vega's default expression compiler relies on.
import { expressionInterpreter } from 'vega-interpreter';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();

let views: vega.View[] = [];

async function render(specs: TopLevelSpec[]): Promise<void> {
    const container = document.getElementById('charts');
    if (!container) {
        return;
    }

    for (const view of views) {
        view.finalize();
    }
    views = [];
    container.replaceChildren();

    for (const spec of specs) {
        const chartDiv = document.createElement('div');
        chartDiv.className = 'chart';
        const chartBody = document.createElement('div');
        chartBody.className = 'chart-body';
        chartDiv.appendChild(chartBody);
        container.appendChild(chartDiv);

        try {
            const vegaSpec = compile(spec).spec;
            const runtime = vega.parse(vegaSpec, undefined, { ast: true });
            const view = new vega.View(runtime, {
                renderer: 'svg',
                container: chartBody,
                hover: true,
                expr: expressionInterpreter,
            });
            await view.runAsync();
            views.push(view);
        } catch (e) {
            chartDiv.classList.add('render-error');
            chartDiv.textContent = `Failed to render visualization: ${e instanceof Error ? e.message : e}`;
        }
    }
}

window.addEventListener('message', (event: MessageEvent) => {
    const message = event.data as { type: string; specs?: TopLevelSpec[] };
    if (message.type === 'render' && message.specs) {
        void render(message.specs);
    }
});

vscode.postMessage({ type: 'ready' });
