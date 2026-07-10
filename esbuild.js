const esbuild = require('esbuild');
const fs = require('fs');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
    // The wasm engine binaries are loaded at runtime by the worker bundle.
    fs.mkdirSync('out', { recursive: true });
    fs.copyFileSync('node_modules/ggsql-wasm/ggsql_wasm_bg.wasm', 'out/ggsql_wasm_bg.wasm');
    fs.copyFileSync('node_modules/@duckdb/duckdb-wasm/dist/duckdb-eh.wasm', 'out/duckdb-eh.wasm');
    // Extension host bundle (Node)
    const extensionCtx = await esbuild.context({
        entryPoints: ['src/extension.ts'],
        bundle: true,
        format: 'cjs',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'node',
        outfile: 'out/extension.js',
        external: ['vscode'],
        logLevel: 'info',
    });

    // Webview bundle (browser) - renders Vega-Lite specs in the results panel
    const webviewCtx = await esbuild.context({
        entryPoints: ['src/webview/main.ts'],
        bundle: true,
        format: 'iife',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'browser',
        outfile: 'out/webview.js',
        logLevel: 'info',
    });

    // Worker bundle (Node) - hosts the ggsql-wasm engine (standalone mode)
    const workerCtx = await esbuild.context({
        entryPoints: ['src/wasmWorker.ts'],
        bundle: true,
        format: 'cjs',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'node',
        outfile: 'out/wasmWorker.js',
        logLevel: 'info',
    });

    const contexts = [extensionCtx, webviewCtx, workerCtx];
    if (watch) {
        await Promise.all(contexts.map(ctx => ctx.watch()));
    } else {
        await Promise.all(contexts.map(ctx => ctx.rebuild()));
        await Promise.all(contexts.map(ctx => ctx.dispose()));
    }
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
