# Changelog

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
