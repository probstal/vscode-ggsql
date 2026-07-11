const esbuild = require('esbuild');
const fs = require('fs');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// web-tree-sitter's ESM build breaks in a CJS bundle (its
// createRequire(import.meta.url) sees undefined), so bundle the CJS build.
const treeSitterAlias = {
    'web-tree-sitter': './node_modules/web-tree-sitter/web-tree-sitter.cjs',
};

async function main() {
    // The wasm engine binaries are loaded at runtime by the worker bundle.
    fs.mkdirSync('out', { recursive: true });
    fs.copyFileSync('node_modules/ggsql-wasm/ggsql_wasm_bg.wasm', 'out/ggsql_wasm_bg.wasm');
    fs.copyFileSync('node_modules/@duckdb/duckdb-wasm/dist/duckdb-eh.wasm', 'out/duckdb-eh.wasm');
    // tree-sitter runtime + vendored ggsql grammar, used by the query
    // splitter (src/treeSplit.ts) in both the extension host and worker.
    fs.copyFileSync('node_modules/web-tree-sitter/web-tree-sitter.wasm', 'out/web-tree-sitter.wasm');
    fs.copyFileSync('vendor/tree-sitter-ggsql/tree-sitter-ggsql.wasm', 'out/tree-sitter-ggsql.wasm');
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
        alias: treeSitterAlias,
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
        alias: treeSitterAlias,
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
