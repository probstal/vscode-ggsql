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
│   ├── dbt.ts                dbt integration: VISUALISE split, `dbt show` runner, row cache
│   ├── panel.ts              Webview results panel (singleton, opens beside the editor)
│   ├── webview/
│   │   └── main.ts           Webview script: compiles specs with vega-lite, renders with vega
│   ├── logging.ts            Shared output channel
│   ├── cellParser.ts         Splits .ggsql files into cells for Run-Cell commands
│   ├── codelens.ts           "▶ Run Query" lens above each cell
│   ├── decorations.ts        Cell separator decorations
│   └── context.ts            Sets editor context keys (e.g. ggsql.hasCodeCells)
├── syntaxes/
│   ├── ggsql.tmLanguage.json TextMate grammar (used for tokenization in VS Code)
│   └── ggsql.injection.tmLanguage.json  Injection grammar for sql/jinja-sql files
├── examples/                 Sample .ggsql files
└── resources/                Static assets bundled with the extension
```

## File extensions and language ID

`package.json` registers `id: ggsql` for `.ggsql`, `.ggsql.sql`, and `.gsql`. The TextMate grammar at `syntaxes/ggsql.tmLanguage.json` provides tokenization.

`syntaxes/ggsql.injection.tmLanguage.json` is an *injection grammar* (`injectTo: source.sql, source.sql.jinja` in `package.json`) that adds ggsql highlighting to plain SQL and dbt jinja-sql files without replacing their grammars. It stays inert until a `VISUALISE`/`VISUALIZE` keyword: its single begin/end block consumes the keyword (a zero-width lookahead begin would trip vscode-textmate's injection loop protection), highlights the VISUALISE clause body itself, delegates DRAW/PLACE/SCALE/FACET/PROJECT/LABEL to the main grammar via `source.ggsql#<rule>` includes, and ends at the next top-level `SELECT`/`WITH` so following SQL statements return to the host grammar. Words like LABEL or SCALE in ordinary SQL are untouched, as are strings/comments (excluded in the `injectionSelector`).

## Commands and keybindings

Declared in `package.json` and wired up in `extension.ts`:

| Command | Default key | Purpose |
| --- | --- | --- |
| `ggsql.runCurrentAdvance` | Cmd/Ctrl+Enter, Shift+Enter | Run current cell, advance to next |
| `ggsql.runQuery` | Cmd/Ctrl+Shift+Enter | Run current cell only |
| `ggsql.runNextCell` | — | Run the next cell |
| `ggsql.runCellsAbove` | — | Run all cells above the cursor |
| `ggsql.sourceCurrentFile` | — | Run the entire file (also exposed as the editor "Run" button) |
| `ggsql.renderDbtFile` | — | Render a VISUALISE clause in a dbt-project sql/jinja-sql file |
| `ggsql.saveChartAsSvg` | — | Save the rendered chart(s) as SVG via a save dialog |
| `ggsql.saveChartAsPng` | — | Save the rendered chart(s) as PNG via a save dialog |
| `ggsql.saveChartAsJson` | — | Save the Vega-Lite spec(s) as JSON via a save dialog |

Cells are detected by `cellParser.ts` (separator: lines starting with `-- %%`); `codelens.ts` puts a CodeLens above each cell.

## Query execution and rendering

Every run command flows through `runner.ts`:

1. Spawns `ggsql exec --reader <reader> <query>` (executable from the `ggsql.executablePath` setting, falling back to `ggsql` on `PATH`). The working directory is the document's folder so relative paths like `FROM 'data.csv'` resolve.
2. The CLI writes a Vega-Lite spec (JSON) to stdout on success; errors go to stderr with a non-zero exit and surface as an error notification plus the `ggsql` output channel.
3. `panel.ts` opens/reuses a singleton "ggsql Results" webview beside the editor and posts the specs to it.
4. `src/webview/main.ts` (bundled separately to `out/webview.js`, browser platform) compiles each spec with `vega-lite` and renders SVG with `vega`.

Running the whole file or "Run Cells Above" executes cells sequentially and renders all resulting charts in the panel.

The save commands (`ggsql.saveChartAsSvg`/`ggsql.saveChartAsPng`/`ggsql.saveChartAsJson`) live in the results panel tab's `...` overflow menu (`editor/title` menu gated on `activeWebviewPanelId == ggsqlResults`). For SVG/PNG, `panel.ts` posts an `export` request to the webview, which answers with `view.toSVG()` markup or a `view.toImageURL('png', 2)` data URL per chart (both built into vega — no extra dependency); JSON is served directly from the specs the panel already holds (pretty-printed, saved as `<name>.vl.json`). The save dialog defaults to the source document's name (extensions stripped, `chartBaseName()` in `extension.ts`) in the last-used save directory (remembered in memory for the window's lifetime, falling back to the workspace folder); with multiple charts the extra ones get `-2`, `-3`, ... name suffixes.

## dbt integration

`dbt.ts` adds a second execution path for `sql`/`jinja-sql` documents inside a dbt project. `context.ts` sets the `ggsql.isDbtVisualiseFile` context key (language is sql/jinja-sql + document contains a top-level `VISUALISE`/`VISUALIZE` + a `dbt_project.yml` exists upward from the file), which shows the "Render ggsql Visualization" run button (`ggsql.renderDbtFile`). The command:

1. `planDbtQuery()` splits the document at the top-level VISUALISE keyword (`splitVisualise()`, a scanner that skips SQL strings/comments, Jinja blocks, and parenthesized subqueries) and decides the shape of the run:
   - *Pattern A* — the SQL part has a top-level SELECT: it goes to dbt as-is, and the render query prepends `SELECT * FROM '<cache>.json'` to the VISUALISE part.
   - *Pattern B* — no top-level SELECT (e.g. the query jumps from the last CTE straight to `VISUALISE ... FROM cte`, or there is no SQL part at all): `select * from <source>` is appended for dbt, where `<source>` is the VISUALISE clause's own FROM; for rendering, that FROM is repointed at the cache file. If neither a top-level SELECT nor a VISUALISE FROM exists, the command errors.
2. `runDbtShow()` runs `dbt --quiet show --inline <sql> --output json --limit -1` with the dbt project root as cwd (executable from `ggsql.dbtPath`, falling back to `dbt` on PATH). dbt compiles the Jinja and executes against the project's target; rows come back as `{"show": [...]}` on stdout.
3. `writeRowsCache()` writes the rows to a content-hash-named JSON file under the extension's global storage.
4. The render query from step 1 goes through the normal `runner.ts`/`panel.ts` path, always with reader `duckdb://memory` (the `ggsql.reader` setting is ignored on this path — the data already sits in the local cache file).

Jinja inside the VISUALISE part is not compiled (only the SQL part goes through dbt). A test dbt project lives at `dbt-proj/` (not shipped; excluded via `.vscodeignore`) with the dbt executable at `dbt-proj/.venv/bin/dbt`.

## Settings

```json
{
  "ggsql.reader": "string",          // --reader connection string, default "duckdb://memory"
  "ggsql.executablePath": "string",  // empty → use 'ggsql' from PATH
  "ggsql.dbtPath": "string"          // empty → use 'dbt' from PATH
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
