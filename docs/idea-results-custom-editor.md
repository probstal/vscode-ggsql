# Idea: results as a custom editor (native preview tabs)

Status: idea only, not started. This replaces the current webview-panel results
architecture (`src/panel.ts`) if/when we want fully native tab UX.

## Motivation

The results panel is a `WebviewPanel` singleton. That means it can never
participate in VS Code's *preview editor* mechanics: italic tab, replaced by the
next open, double-click (or edit) to keep, native per-tab lifecycle, restore
after window reload. The API offers no way in — `createWebviewPanel` has no
preview option, `Tab.isPreview` is read-only, and tab double-clicks are not
observable. The desired UX (discussed 2026-07-10):

- Running a query opens the chart as a *preview* tab (italic) that the next run
  replaces — regardless of which source file it came from.
- The user can promote the tab (double-click, native) to keep it; a kept tab is
  dedicated to its source file.
- Rerunning a file that has a kept tab updates **that tab in place** and reveals
  it — no new preview tab, no duplicate (mirrors VS Code reusing an existing tab
  when you open an already-open file).

All of this comes for free from the workbench if each result is a **resource
opened in a custom editor** instead of a hand-managed panel.

## Architecture sketch

1. **Result files.** Each run writes its output to a JSON file, e.g.
   `<globalStorage>/results/<sourceBaseName>.ggchart` — content: the Vega-Lite
   specs array plus metadata (source file path, timestamp, base name for
   save-as defaults). One file per *source document* (stable path), so
   rerunning a file overwrites its resource — that is what makes "kept tab
   updates in place" work.
2. **Custom editor.** Register a `CustomReadonlyEditorProvider`
   (`package.json` `contributes.customEditors`, viewType e.g.
   `ggsql.chartEditor`, selector `*.ggchart`). `resolveCustomEditor` sets up
   the webview exactly like today's panel: same `out/webview.js` bundle, same
   CSP/HTML (reuse `getHtml`), posts the specs read from the document.
3. **Opening.** After writing the file:
   `vscode.commands.executeCommand('vscode.open', uri, { preview: true, viewColumn: ViewColumn.Beside, preserveFocus: true })`.
   The workbench then does everything: preview tab (italic), replacement on the
   next `vscode.open` of a *different* result uri, reuse of an existing tab for
   the *same* uri, keep-on-double-click.
4. **Live update.** When a rerun overwrites an already-open resource, the
   provider must refresh: watch the file (`vscode.workspace.createFileSystemWatcher`
   or just track open webviews per uri in the provider) and re-post the specs.
5. **Persistence across reload.** Custom editors reopen automatically (provider
   reads the file again) — result tabs survive window reloads, unlike today.
   Consider pruning `<globalStorage>/results/` on activation (keep last N).

## What has to move (current features to carry over)

- **Save as SVG/PNG/JSON** (`ggsql.saveChartAs*`): menu `when` clauses change
  from `activeWebviewPanelId == ggsqlResults` to
  `activeCustomEditorId == ggsql.chartEditor`. JSON save reads the resource
  directly; SVG/PNG still round-trip to the webview (`export` message —
  plumbing moves from `GgsqlResultPanel` into the provider, keyed per editor).
- **Loading overlay + error overlay** (spinner / red error text): today these
  are posted to the singleton. With editors, target the editor whose *source
  file* is being rerun (provider keeps a map source→open webviews). If the
  source has no open result editor yet, there is nothing to overlay (same as
  today's first run) — errors then fall back to the notification path
  (`handleRunFailure` in `extension.ts`).
- **Run pipeline** (`executeQueries` / `runDbtVisualisation`): unchanged up to
  the point of display; `GgsqlResultPanel.show(...)` is replaced by
  "write .ggchart file + vscode.open". Single-active-run cancellation
  (`activeRun` AbortController) is orthogonal and stays.
- **Tab title**: file name comes from the resource name automatically
  (`<sourceBaseName>.ggchart`); pick the filename so tabs read nicely, or use
  `TabInputCustom` + no control — the resource basename IS the title.

## Gotchas

- `supportsMultipleEditorsPerDocument: false` (default) is what we want.
- The webview per editor needs `retainContextWhenHidden` (set in
  `resolveCustomEditor`'s options) or cheap re-render on restore — re-render is
  probably fine, vega is fast.
- `.ggchart` files live in globalStorage, not the workspace — they won't
  pollute the user's project or git status.
- Don't register `.ggchart` as a language; only the custom editor selector.
- The old `GgsqlResultPanel` can be deleted at the end; `webview/main.ts` is
  reused as-is (messages: `render`, `export`, `loading`, `error`).

## Suggested order of work

1. Provider + `.ggchart` writing + `vscode.open` with `preview: true`; verify
   preview/keep/replace tab behavior manually.
2. Live update on rerun (watcher or provider-side map).
3. Move save commands' menu contributions and export plumbing.
4. Move loading/error overlay targeting.
5. Delete `panel.ts`, update CLAUDE.md.
