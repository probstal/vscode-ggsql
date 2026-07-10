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

function setLoading(loading: boolean): void {
    const overlay = document.getElementById('overlay');
    if (!overlay) {
        return;
    }
    overlay.classList.remove('error');
    overlay.classList.toggle('visible', loading);
}

/** Keep the overlay up but swap the spinner for the error message. */
function showError(message: string): void {
    const overlay = document.getElementById('overlay');
    const error = document.getElementById('overlay-error');
    if (!overlay || !error) {
        return;
    }
    error.textContent = message;
    overlay.classList.add('visible', 'error');
}

async function render(specs: TopLevelSpec[]): Promise<void> {
    setLoading(false);
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

/**
 * Export every rendered chart via the vega View API: raw SVG markup for
 * 'svg', a base64 data URL (rendered through a canvas) for 'png'.
 */
async function exportCharts(format: 'svg' | 'png', id: number): Promise<void> {
    try {
        const images: string[] = [];
        for (const view of views) {
            images.push(
                format === 'svg' ? await view.toSVG() : await view.toImageURL('png', 2)
            );
        }
        vscode.postMessage({ type: 'exportResult', id, images });
    } catch (e) {
        vscode.postMessage({
            type: 'exportResult',
            id,
            error: e instanceof Error ? e.message : String(e),
        });
    }
}

window.addEventListener('message', (event: MessageEvent) => {
    const message = event.data as {
        type: string;
        specs?: TopLevelSpec[];
        format?: 'svg' | 'png';
        id?: number;
        loading?: boolean;
        message?: string;
    };
    if (message.type === 'render' && message.specs) {
        void render(message.specs);
    } else if (message.type === 'export' && message.format && message.id !== undefined) {
        void exportCharts(message.format, message.id);
    } else if (message.type === 'loading') {
        setLoading(message.loading === true);
    } else if (message.type === 'error' && message.message !== undefined) {
        showError(message.message);
    }
});

vscode.postMessage({ type: 'ready' });
