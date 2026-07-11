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
│   ├── runner.ts             Query execution: engine dispatch + `ggsql exec` CLI path
│   ├── standalone.ts         Standalone engine: worker client, cancellation, run-tree logs
│   ├── wasmWorker.ts         Worker thread: duckdb-wasm (SQL) + ggsql-wasm (VISUALISE)
│   ├── querySplit.ts         Scanner-based VISUALISE/statement splitting (no vscode imports)
│   ├── treeSplit.ts          Grammar-based VISUALISE splitting via tree-sitter (no vscode imports)
│   ├── errors.ts             GgsqlError/QueryCancelledError (no vscode imports)
│   ├── dbt.ts                dbt integration: `dbt show` runner, row cache
│   ├── panel.ts              Webview results panel (singleton, opens beside the editor)
│   ├── webview/
│   │   └── main.ts           Webview script: compiles specs with vega-lite, renders with vega
│   ├── logging.ts            Output channel + run-tree formatting helpers
│   ├── cellParser.ts         Splits .ggsql files into cells for Run-Cell commands
│   ├── codelens.ts           "▶ Run Query" lens above each cell
│   ├── decorations.ts        Cell separator decorations
│   └── context.ts            Sets editor context keys (e.g. ggsql.hasCodeCells)
├── syntaxes/
│   ├── ggsql.tmLanguage.json TextMate grammar (used for tokenization in VS Code)
│   └── ggsql.injection.tmLanguage.json  Injection grammar for sql/jinja-sql files
├── examples/                 Sample .ggsql files
├── resources/                Static assets bundled with the extension
├── scripts/
│   └── update-grammar.sh     Re-vendor the tree-sitter grammar + rebuild its wasm
└── vendor/
    └── tree-sitter-ggsql/    Vendored ggsql grammar, pinned to the ggsql-wasm version
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

Every run command flows through `runner.ts` (`runQuery()`), which dispatches on the `ggsql.engine` setting:

- **standalone** (default): `standalone.ts` sends the query to a `worker_threads` worker (`wasmWorker.ts` → `out/wasmWorker.js`) hosting two wasm engines, both binaries copied to `out/` by esbuild.js: **duckdb-wasm** (`@duckdb/duckdb-wasm/blocking`, `duckdb-eh.wasm`) executes the SQL, **ggsql-wasm** (`ggsql_wasm_bg.wasm`) renders the VISUALISE clause. Per statement (split at top-level semicolons, `splitStatements()` in querySplit.ts) the worker mirrors the dbt pattern: `planSplit()` (treeSplit.ts) splits at VISUALISE, the SQL part runs on duckdb via `COPY (sql) TO '<tmp>.parquet'`, the parquet is registered with ggsql as table `duckdb_result`, and the rewritten VISUALISE query produces the spec. Statements without a VISUALISE run plain on duckdb (side effects persist in its catalog across runs until cancel/reload). duckdb-wasm's NODE_FS runtime reads files referenced in queries (CSV/JSON/Parquet/globs) directly from disk — full DuckDB file support; a runtime wrapper (`makeRuntime()`) resolves relative paths against the document folder, since the wasm has no cwd (all file requests funnel through the `glob`/`checkFile` runtime hooks). Special routes: statements with `FROM ggsql:dataset` (builtins only exist in the ggsql context, resolved *unquoted*; registered best-effort at startup, may need network) go wholly to ggsql-wasm, as do statements where our splitter and ggsql's `has_visual()` disagree (parser wins, avoiding seam mis-splits); the reverse disagreement runs as plain SQL on duckdb. Errors are stage-tagged (`DuckDB: ...` / `ggsql: ...`). Both engines execute synchronously — the worker keeps the extension host responsive and makes cancellation possible (`worker.terminate()`, fresh worker + fresh engine state on the next run). The stale bridge parquet is deleted before each COPY (duckdb opens without truncating; a cancel mid-COPY would otherwise corrupt the next run's footer). The `ggsql.reader` setting is ignored.
- **cli**: spawns `ggsql exec --reader <reader> <query>` (executable from `ggsql.executablePath`, falling back to `ggsql` on `PATH`; reader from `ggsql.reader`). The working directory is the document's folder so relative paths like `FROM 'data.csv'` resolve. The CLI writes Vega-Lite spec(s) to stdout; errors go to stderr with a non-zero exit.

### Query splitting

Splitting a query at the VISUALISE boundary (and picking Pattern A/B, see the dbt section) is two-tiered. The primary splitter is `planSplit()` in treeSplit.ts: it parses the statement with web-tree-sitter and the **vendored tree-sitter-ggsql grammar** (`vendor/tree-sitter-ggsql/`, compiled to `tree-sitter-ggsql.wasm`; both copied to `out/` by esbuild.js, which also aliases `web-tree-sitter` to its CJS build — the ESM build's `createRequire(import.meta.url)` breaks inside a CJS bundle). The VISUALISE boundary, the Pattern A/B decision (type of the last `sql_statement` node), and the `VISUALISE FROM` source (the `table_ref` node's `table` field) are all read off CST nodes, and DuckDB-style FROM-first statements get `SELECT * ` prepended, mirroring ggsql's own `extract_sql()`. Because the grammar is pinned to the bundled ggsql-wasm version (`scripts/update-grammar.sh`, ref recorded in `vendor/tree-sitter-ggsql/UPSTREAM`), the split cannot disagree with what the engine parses. The scanner in querySplit.ts remains as fallback — used until the grammar wasm finishes loading and whenever a statement doesn't parse cleanly (ERROR nodes) — and such runs are marked `split via scanner: ...` in the run tree. `splitStatements()` (semicolons) and the `ggsql.isDbtVisualiseFile` context key stay scanner-based: the grammar's root rule can't represent plain SQL *after* a VISUALISE statement, and the context key must be cheap and sync.

Every run writes an explain-style tree to the `ggsql` output channel (helpers in logging.ts: `timestamp()`, `oneLine()`, `formatMs()`, shared `nextRunNumber()`), showing per step which engine ran what, row/spec counts, and durations:

```
[12:03:12.345] run #3 · standalone · ok · 45ms · cwd: /Users/x/proj
├─ statement 1/2
│  ├─ duckdb ▸ SELECT city, temp FROM 'weather.csv'  → 365 rows · 12ms
│  └─ ggsql ▸ SELECT * FROM 'duckdb_result' VISUALISE …  → 1 spec · 4ms
└─ statement 2/2
   └─ duckdb ▸ CREATE TABLE t AS …  → 0 rows · 3ms
```

The trace is produced in the worker (`TraceStep`/`StatementTrace` in wasmWorker.ts) and formatted by `formatTrace()` in standalone.ts; CLI runs log an equivalent single-step tree from runner.ts; the dbt path logs its `dbt show` step (rows + duration) before handing off to the renderer run.

Then `panel.ts` opens/reuses a singleton webview beside the editor (tab title `Chart <filename>` of the source document) and posts the specs to it; `src/webview/main.ts` (bundled separately to `out/webview.js`, browser platform) compiles each spec with `vega-lite` and renders SVG with `vega`.

Runs are cancelable and exclusive: each run shows a cancellable `ProgressLocation.Notification`, wired via an `AbortController` to the child process (`signal` option on `execFile` in `runner.ts`/`dbt.ts`) or the wasm worker (terminated on abort); aborting rejects with `QueryCancelledError`. Starting a new run aborts the previous one (`startRun()`/`activeRun` in `extension.ts`), so only one query is ever in flight. Cancellation is silent — the loading overlay is cleared (unless a newer run owns it) and no error is shown.

Running the whole file or "Run Cells Above" executes cells sequentially and renders all resulting charts in the panel.

While a query runs, the previous charts stay visible under a dark loading overlay with a CSS spinner: both run paths call `GgsqlResultPanel.setLoading(true)` before running (a no-op if no panel is open yet), which posts a `loading` message to the webview. On success, rendering the new specs clears the overlay; on failure, `reportQueryError()` (extension.ts) calls `GgsqlResultPanel.showError()`, which keeps the overlay up but swaps the spinner for the red error text (Vue-HMR style) until the next run. If no panel is open to show it, the error falls back to the notification + output channel.

The save commands (`ggsql.saveChartAsSvg`/`ggsql.saveChartAsPng`/`ggsql.saveChartAsJson`) live in the results panel tab's `...` overflow menu (`editor/title` menu gated on `activeWebviewPanelId == ggsqlResults`). For SVG/PNG, `panel.ts` posts an `export` request to the webview, which answers with `view.toSVG()` markup or a `view.toImageURL('png', 2)` data URL per chart (both built into vega — no extra dependency); JSON is served directly from the specs the panel already holds (pretty-printed, saved as `<name>.vl.json`). The save dialog defaults to the source document's name (extensions stripped, `chartBaseName()` in `extension.ts`) in the last-used save directory (remembered in memory for the window's lifetime, falling back to the workspace folder); with multiple charts the extra ones get `-2`, `-3`, ... name suffixes.

## dbt integration

`dbt.ts` adds a second execution path for `sql`/`jinja-sql` documents inside a dbt project. `context.ts` sets the `ggsql.isDbtVisualiseFile` context key (language is sql/jinja-sql + document contains a top-level `VISUALISE`/`VISUALIZE` + a `dbt_project.yml` exists upward from the file), which shows the "Render ggsql Visualization" run button (`ggsql.renderDbtFile`). The command:

1. `planSplit()` (treeSplit.ts, shared with the standalone engine) splits the document at the top-level VISUALISE keyword and decides the shape of the run:
   - *Pattern A* — the SQL part has a top-level SELECT: it goes to dbt as-is, and the render query prepends `SELECT * FROM '<cache>.json'` to the VISUALISE part.
   - *Pattern B* — no top-level SELECT (e.g. the query jumps from the last CTE straight to `VISUALISE ... FROM cte`, or there is no SQL part at all): `select * from <source>` is appended for dbt, where `<source>` is the VISUALISE clause's own FROM; for rendering, that FROM is repointed at the cache file. If neither a top-level SELECT nor a VISUALISE FROM exists, the command errors.
2. `runDbtShow()` runs `dbt --quiet show --inline <sql> --output json --limit -1` with the dbt project root as cwd (executable from `ggsql.dbtPath`, falling back to `dbt` on PATH). dbt compiles the Jinja and executes against the project's target; rows come back as `{"show": [...]}` on stdout.
3. `writeRowsCache()` writes the rows to a content-hash-named JSON file under the extension's global storage, and the render query goes through the normal `runner.ts`/`panel.ts` path with reader `duckdb://memory` — both engines read the JSON cache themselves (duckdb-wasm directly in standalone mode, the CLI via its in-memory duckdb; a custom `ggsql.reader` is deliberately ignored here).

Jinja inside the VISUALISE part is not compiled (only the SQL part goes through dbt). A test dbt project lives at `dbt-proj/` (not shipped; excluded via `.vscodeignore`) with the dbt executable at `dbt-proj/.venv/bin/dbt`.

## Settings

```json
{
  "ggsql.engine": "standalone|cli",  // default "standalone" (bundled wasm engine)
  "ggsql.reader": "string",          // --reader connection string, default "duckdb://memory"; cli engine only
  "ggsql.executablePath": "string",  // empty → use 'ggsql' from PATH; cli engine only
  "ggsql.dbtPath": "string"          // empty → use 'dbt' from PATH
}
```

## Build & package

```sh
cd ggsql-vscode
npm install                # one-time
npm run check-types        # tsc --noEmit
npm run package            # esbuild → out/{extension,webview,wasmWorker}.js + wasm binaries (production)
npx vsce package           # produces ggsql-<version>.vsix
code --install-extension ggsql-<version>.vsix
```

Watch mode for development: `npm run watch` (runs esbuild + tsc in parallel).

When bumping the `ggsql-wasm` dependency, re-vendor the split grammar to the matching upstream tag: `scripts/update-grammar.sh v<version>` (needs the tree-sitter CLI devDependency; downloads wasi-sdk to `~/.cache/tree-sitter` on first wasm build) and commit the `vendor/tree-sitter-ggsql/` changes including `tree-sitter-ggsql.wasm`.
