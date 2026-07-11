# Changelog

## 0.4.0

- Standalone engine (new default): queries run on a bundled wasm engine, so no `ggsql`
  CLI install is needed anymore. Full DuckDB file support (CSV/JSON/Parquet/
  globs) with relative paths resolved against the document's folder; tables
  created in one cell stay available to later runs. Queries run off the
  extension host and are cancelled instantly. The new `ggsql.engine` setting
  (`standalone`/`cli`) switches back to the previous CLI behavior.
- Built-in datasets (`ggsql:penguins`, `ggsql:airquality`, `ggsql:world`) are
  now bundled with the extension: in standalone mode they run on DuckDB like
  any other data — same SQL dialect, mixable with your own tables and files,
  and available offline.
- Queries are now split at the `VISUALISE` boundary using the actual ggsql
  tree-sitter grammar (pinned to the engine version) instead of a hand-rolled
  scanner, making the split robust for tricky SQL. This also fixes DuckDB
  `FROM`-first queries (`FROM 'data.csv' VISUALISE ...`) failing to run.
- Better logging: every run writes an explain-style tree to the `ggsql` output
  channel showing per statement which engine ran what, row/spec counts, and
  durations. Set the channel's log level to *Debug* (gear icon in the Output
  panel) to additionally see every query untruncated.

## 0.3.0

- Chart export: save rendered charts as SVG, PNG, or the Vega-Lite spec as JSON
  via the results panel's `...` menu.
- Loading spinner: while a query runs, the previous charts stay visible under a
  loading overlay; on failure the error is shown in the panel instead of a
  notification.
- Query cancellation: runs show a cancellable progress notification, and
  starting a new run aborts the previous one, so only one query is ever in
  flight.

## 0.2.1

- Updated the README with VS Code Marketplace install instructions

## 0.2.0

- dbt integration: `sql`/`jinja-sql` files inside a dbt project that contain the `VISUALISE`/`VISUALIZE`
  keyword get a "Render ggsql Visualization" run button.
  The SQL part is compiled and executed by the dbt CLI using `dbt show`
  and the VISUALISE part is rendered by ggsql reading that file through its duckdb reader.
- New setting: `ggsql.dbtPath` (path to the `dbt` executable, defaults to
  `dbt` on PATH).

## 0.1.0

- Converted to a pure VS Code extension: removed the Positron language runtime,
  connection drivers, and the ggsql-jupyter kernel integration.
- Queries now run through the `ggsql` CLI (`ggsql exec`); the run button, code
  lenses, and cell keybindings all execute via the CLI.
- Generated charts are rendered with Vega-Lite in a "ggsql Results" webview
  panel beside the editor.
- New settings: `ggsql.reader` (data source connection string passed via
  `--reader`, default `duckdb://memory`) and `ggsql.executablePath` (path to
  the `ggsql` binary, defaults to `ggsql` on PATH). The `ggsql.kernelPath`
  setting was removed.
