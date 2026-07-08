# `ggsql-vscode/` — VS Code extension

TypeScript extension that adds ggsql language support to VS Code: syntax highlighting, code-cell execution via the `ggsql` CLI, and a webview results panel that renders the generated Vega-Lite charts.

Not a Cargo workspace member — this is a standalone npm project. End-user docs live in [`README.md`](README.md). This file describes the *implementation*.

## Layout

```
ggsql-vscode/
├── package.json              Extension manifest (commands, keybindings, languages, settings)
├── tsconfig.json
├── esbuild.js                Bundler config (builds out/extension.js and out/webview.js)
├── eslint.config.mjs
├── language-configuration.json   Bracket pairs, comment markers
├── logo.png, icon.png
├── src/
│   ├── extension.ts          activate(): registers commands, code lenses, decorations
│   ├── runner.ts             Executes queries via `ggsql exec --reader <reader> <query>`
│   ├── panel.ts              Webview results panel (singleton, opens beside the editor)
│   ├── webview/
│   │   └── main.ts           Webview script: compiles specs with vega-lite, renders with vega
│   ├── logging.ts            Shared output channel
│   ├── cellParser.ts         Splits .ggsql files into cells for Run-Cell commands
│   ├── codelens.ts           "▶ Run Query" lens above each cell
│   ├── decorations.ts        Cell separator decorations
│   └── context.ts            Sets editor context keys (e.g. ggsql.hasCodeCells)
├── syntaxes/
│   └── ggsql.tmLanguage.json TextMate grammar (used for tokenization in VS Code)
├── examples/                 Sample .ggsql files
└── resources/                Static assets bundled with the extension
```

## File extensions and language ID

`package.json` registers `id: ggsql` for `.ggsql`, `.ggsql.sql`, and `.gsql`. The TextMate grammar at `syntaxes/ggsql.tmLanguage.json` provides tokenization.

## Commands and keybindings

Declared in `package.json` and wired up in `extension.ts`:

| Command | Default key | Purpose |
| --- | --- | --- |
| `ggsql.runCurrentAdvance` | Cmd/Ctrl+Enter, Shift+Enter | Run current cell, advance to next |
| `ggsql.runQuery` | Cmd/Ctrl+Shift+Enter | Run current cell only |
| `ggsql.runNextCell` | — | Run the next cell |
| `ggsql.runCellsAbove` | — | Run all cells above the cursor |
| `ggsql.sourceCurrentFile` | — | Run the entire file (also exposed as the editor "Run" button) |

Cells are detected by `cellParser.ts` (separator: lines starting with `-- %%`); `codelens.ts` puts a CodeLens above each cell.

## Query execution and rendering

Every run command flows through `runner.ts`:

1. Spawns `ggsql exec --reader <reader> <query>` (executable from the `ggsql.executablePath` setting, falling back to `ggsql` on `PATH`). The working directory is the document's folder so relative paths like `FROM 'data.csv'` resolve.
2. The CLI writes a Vega-Lite spec (JSON) to stdout on success; errors go to stderr with a non-zero exit and surface as an error notification plus the `ggsql` output channel.
3. `panel.ts` opens/reuses a singleton "ggsql Results" webview beside the editor and posts the specs to it.
4. `src/webview/main.ts` (bundled separately to `out/webview.js`, browser platform) compiles each spec with `vega-lite` and renders SVG with `vega`.

Running the whole file or "Run Cells Above" executes cells sequentially and renders all resulting charts in the panel.

## Settings

```json
{
  "ggsql.reader": "string",          // --reader connection string, default "duckdb://memory"
  "ggsql.executablePath": "string"   // empty → use 'ggsql' from PATH
}
```

## Build & package

```sh
cd ggsql-vscode
npm install                # one-time
npm run check-types        # tsc --noEmit
npm run package            # esbuild → out/extension.js + out/webview.js (production)
npx vsce package           # produces ggsql-<version>.vsix
code --install-extension ggsql-<version>.vsix
```

Watch mode for development: `npm run watch` (runs esbuild + tsc in parallel).
