/*
 * CST-based query splitting via the vendored tree-sitter-ggsql grammar
 * (vendor/tree-sitter-ggsql/, pinned to the bundled ggsql-wasm version
 * by scripts/update-grammar.sh).
 *
 * Same job as planSplitQuery() in querySplit.ts, but the VISUALISE
 * boundary, the Pattern A/B decision, and the VISUALISE FROM source all
 * come from parse-tree nodes instead of a hand-rolled scanner — the same
 * grammar ggsql itself parses with, so the split can't disagree with the
 * engine. The scanner stays as the fallback whenever the grammar isn't
 * loaded or the parse tree contains errors.
 *
 * No vscode imports — bundled into both the extension host and the wasm
 * worker.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Language, Node, Parser } from 'web-tree-sitter';
import { GgsqlError } from './errors';
import { planSplitQuery, quotePath, SplitQueryPlan } from './querySplit';

let parser: Parser | undefined;
let initPromise: Promise<boolean> | undefined;

/**
 * Load web-tree-sitter and the ggsql grammar from `wasmDir` (the bundle
 * output directory holding web-tree-sitter.wasm and
 * tree-sitter-ggsql.wasm). Idempotent; resolves false if loading fails,
 * in which case planSplit() serves scanner results.
 */
export function initTreeSplit(wasmDir: string): Promise<boolean> {
    if (!initPromise) {
        initPromise = (async () => {
            await Parser.init({
                locateFile: (file: string) => path.join(wasmDir, file),
            });
            const language = await Language.load(
                new Uint8Array(fs.readFileSync(path.join(wasmDir, 'tree-sitter-ggsql.wasm')))
            );
            parser = new Parser().setLanguage(language);
            return true;
        })().catch(() => false);
    }
    return initPromise;
}

export interface SplitOutcome {
    /** undefined = no VISUALISE clause, run as plain SQL */
    plan: SplitQueryPlan | undefined;
    /** Set when the scanner answered instead of the grammar, and why. */
    fallback?: 'grammar unavailable' | 'parse error';
}

/**
 * Plan a split like planSplitQuery(), preferring the grammar. Falls back
 * to the scanner before initTreeSplit() resolves true or when the text
 * doesn't parse cleanly. Throws GgsqlError (either path) if a VISUALISE
 * exists but the data source cannot be determined.
 */
export function planSplit(text: string): SplitOutcome {
    if (!parser) {
        return { plan: planSplitQuery(text), fallback: 'grammar unavailable' };
    }
    const tree = parser.parse(text);
    if (!tree) {
        return { plan: planSplitQuery(text), fallback: 'parse error' };
    }
    try {
        if (tree.rootNode.hasError) {
            return { plan: planSplitQuery(text), fallback: 'parse error' };
        }
        return { plan: planFromTree(text, tree.rootNode) };
    } finally {
        tree.delete();
    }
}

function planFromTree(text: string, root: Node): SplitQueryPlan | undefined {
    const viz = root.namedChildren.find(n => n?.type === 'visualise_statement');
    if (!viz) {
        return undefined;
    }
    const visualise = text.slice(viz.startIndex).trim();

    // Pattern A: the SQL part ends in a statement that produces a result
    // set — run it as-is and prepend the result to the VISUALISE part.
    // Bare DuckDB-style FROM statements get SELECT * prepended so every
    // engine sees standard SQL (mirrors ggsql's own extract_sql()).
    const last = lastSqlStatement(root);
    const resultStart = last && resultProducingStart(last);
    if (resultStart) {
        const sql =
            resultStart.prependSelectStar === undefined
                ? text.slice(0, viz.startIndex)
                : text.slice(0, resultStart.prependSelectStar) +
                  'SELECT * ' +
                  text.slice(resultStart.prependSelectStar, viz.startIndex);
        return {
            sql: sql.trim(),
            buildRenderQuery: source =>
                `SELECT * FROM ${quotePath(source)}\n${visualise}`,
        };
    }

    // Pattern B: no result-producing SQL — the VISUALISE clause's own
    // FROM names the source. Query it for the engine, and repoint it at
    // the engine's result for rendering.
    const source = viz.namedChildren
        .find(n => n?.type === 'from_clause')
        ?.namedChildren.find(n => n?.type === 'table_ref')
        ?.childForFieldName('table');
    if (!source) {
        throw new GgsqlError(
            'Cannot determine the data source: the SQL before VISUALISE is not a ' +
            'SELECT and the VISUALISE clause has no FROM.'
        );
    }
    const sql = text.slice(0, viz.startIndex).trim();
    const start = source.startIndex - viz.startIndex;
    const end = source.endIndex - viz.startIndex;
    return {
        sql: `${sql ? sql + '\n' : ''}select * from ${text.slice(source.startIndex, source.endIndex)}`,
        buildRenderQuery: renderSource =>
            visualise.slice(0, start) + quotePath(renderSource) + visualise.slice(end),
    };
}

/** Last sql_statement of the sql_portion, if any. */
function lastSqlStatement(root: Node): Node | undefined {
    const portion = root.namedChildren.find(n => n?.type === 'sql_portion');
    const statements = portion?.namedChildren.filter(n => n?.type === 'sql_statement');
    return statements?.length ? statements[statements.length - 1] ?? undefined : undefined;
}

/**
 * Whether a sql_statement produces a result set (SELECT, bare FROM, or
 * WITH ending in either). `prependSelectStar` is set to the offset of a
 * bare FROM statement that needs SELECT * in front of it.
 */
function resultProducingStart(statement: Node): { prependSelectStar?: number } | undefined {
    const inner = statement.namedChildren[0];
    switch (inner?.type) {
        case 'select_statement':
            return {};
        case 'from_statement':
            return { prependSelectStar: inner.startIndex };
        case 'with_statement': {
            const tail = inner.namedChildren.find(
                n => n?.type === 'select_statement' || n?.type === 'from_statement'
            );
            if (!tail) {
                return undefined;
            }
            return tail.type === 'from_statement'
                ? { prependSelectStar: tail.startIndex }
                : {};
        }
        default:
            return undefined;
    }
}
