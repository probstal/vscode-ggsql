# Changelog

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
