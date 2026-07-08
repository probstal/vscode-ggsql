const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
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

    if (watch) {
        await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
    } else {
        await Promise.all([extensionCtx.rebuild(), webviewCtx.rebuild()]);
        await Promise.all([extensionCtx.dispose(), webviewCtx.dispose()]);
    }
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
