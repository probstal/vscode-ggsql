# ggsql for VS Code

<p align="center">
  <img src="logo.png" height="64" alt="ggsql logo">
</p>
<p align="center">
  <a href="https://ggsql.org/syntax/"><b>Syntax Reference</b></a> |
  <a href="https://ggsql.org/gallery/"><b>Gallery</b></a> |
  <a href="https://marketplace.visualstudio.com/items?itemName=probstal.vscode-ggsql"><b>VS Code Marketplace</b></a>
</p>

[ggsql](https://ggsql.org) is a SQL extension for declarative data visualization based on the Grammar of Graphics: a single, composable query describes both the data and the chart. This extension runs ggsql right in VS Code including first-class [dbt](https://www.getdbt.com) support for charts on top of your dbt models.

New to ggsql? Build [your first plot](https://ggsql.org/get_started/first_plot.html) or pick something from the [gallery](https://ggsql.org/gallery/). Create a file with the `.ggsql` extension, paste the example, and run it right in your editor.

> **Note**: ggsql and this VS Code extension are still in early development and all functionality is subject to change.

## Example

```sql
VISUALISE
  bill_len AS x,
  bill_dep AS y,
  species AS fill
FROM ggsql:penguins
DRAW point
SCALE x 
  RENAMING * => '{} mm'
LABEL
  title => 'Relationship between bill dimensions in 3 species of penguins',
  x => 'Bill length',
  y => 'Bill depth'
```

![Screenshot](.github/assets/screenshot.png)

## Why ggsql?

Many data analysts are naturally at home in SQL and spend more time there than in Python or R. Having to extract data, switch to another language, import the data, and set up a plotting library is cumbersome when all you want is to understand the data you are working with *right now*.

ggsql is built for immediate familiarity with SQL and stands on the Grammar of Graphics known from [ggplot2](https://ggplot2.tidyverse.org/), giving you a composable syntax that scales from a quick scatter plot to arbitrarily complex visualizations. The syntax is easy to learn, read, and write.
This also means that it is a great fit for AI agents to produce as the output query is immediately easy to understand and validate by the user so that you can have certainty in its validity.

## Getting started

1. Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=probstal.vscode-ggsql) (or [manually](#manual-installation)).
2. Create a file called `demo.ggsql` and paste the example above.
3. Hit the Run button (or `Cmd/Ctrl+Enter`) and the chart opens in a panel beside your editor.

Queries run on an engine bundled with the extension (DuckDB and ggsql, compiled to WebAssembly). Your SQL executes on DuckDB with full file support resolved relative to your file.
The `VISUALISE` clause is rendered by ggsql.

## Extension Features

- Complete syntax highlighting for ggsql queries (`.ggsql`/`.gsql` files, plus `VISUALISE` clauses inside your dbt files).
- Zero-setup query execution on the bundled engine: full DuckDB SQL against your CSV/JSON/Parquet files and the built-in datasets; tables you create stay available for later runs.
- Rendered charts appear in a results panel next to your editor, powered by [Vega-Lite](https://vega.github.io/vega-lite/), with export to SVG, PNG, or the Vega-Lite spec as JSON.
- [dbt](https://www.getdbt.com) support: render a `VISUALISE` clause in a SQL file of your dbt project, executed against your configured dbt target.
- Cancellable runs and an explain-style run log in the `ggsql` output channel.

## Using with dbt

Files with language `sql` or `jinja-sql` that live inside a dbt project (a `dbt_project.yml` is found upward from the file) and contain a `VISUALISE`/`VISUALIZE` clause get an additional "Render ggsql Visualization" button in the editor toolbar. This works well for exploratory charts in your project's `analyses/` folder:

```sql
SELECT
  order_date,
  revenue,
  region
FROM {{ ref('fct_orders') }}

VISUALISE
  order_date AS x,
  revenue AS y,
  region AS color
DRAW line
LABEL title => 'Revenue by region'
```

When run, the SQL part (everything before `VISUALISE`) is compiled and executed by the dbt CLI (`dbt show`) against your project's target, so refs, macros, and profiles resolve exactly like a normal dbt run. The VISUALISE part is rendered by ggsql reading that file through its duckdb reader.

This requires the `dbt` executable (configure `ggsql.dbtPath` if it lives in a virtualenv).

**Note that Jinja inside the `VISUALISE` part itself is not compiled.**

## Optional: using the ggsql CLI

By default everything runs on the bundled engine.
For querying real databases, it is recommended to let [dbt](#using-with-dbt) handle the database connection.
However, setting `ggsql.engine` to `cli` runs queries through the [ggsql CLI](https://ggsql.org/get_started/installation.html) instead, which is mainly for advanced users:

- Custom data sources via `ggsql.reader`: use a persistent DuckDB database, SQLite, or ODBC connections.
- If you hit a problem with the standalone engine, the CLI mode is a reliable fallback.

Install the CLI on your `PATH` or point `ggsql.executablePath` at it. You need to restart VS Cod for the `PATH` to update after the CLI installation.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `ggsql.engine` | `standalone` | Query engine: `standalone` runs on the bundled wasm engine, `cli` spawns the `ggsql` CLI. |
| `ggsql.reader` | `duckdb://memory` | Data source connection string passed to the CLI via `--reader` (e.g. `duckdb://path/to.db`, `sqlite://path/to.db`, `odbc://...`). CLI engine only. |
| `ggsql.executablePath` | *(empty)* | Path to the `ggsql` executable. If empty, `ggsql` is resolved from `PATH`. CLI engine only. |
| `ggsql.dbtPath` | *(empty)* | Path to the `dbt` executable used for dbt-project files (e.g. the `.venv/bin/dbt`). If empty, `dbt` is resolved from `PATH`. |

## Manual installation

You can download the extension from the GitHub releases and install it manually:

1. Download `vscode-ggsql-0.4.0.vsix` from [GitHub Releases](https://github.com/probstal/vscode-ggsql/releases)
2. Install via the command line:

```bash
code --install-extension vscode-ggsql-0.4.0.vsix
```

Or install from within the editor: open the Extensions view, click the `...` menu, select "Install from VSIX...", and choose the downloaded file.

## Learn more

Visit [ggsql.org](https://ggsql.org) for the full documentation with interactive examples, or try ggsql in the browser on the [playground](https://ggsql.org/wasm/).

This project is a fork of the official [ggsql-vscode extension](https://github.com/posit-dev/ggsql/tree/main/ggsql-vscode) focused on extensive VS Code and [dbt](https://www.getdbt.com) features.
