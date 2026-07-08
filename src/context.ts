import * as vscode from 'vscode';
import * as path from 'path';
import { parseCells } from './cellParser';
import { findDbtProjectRoot, splitVisualise } from './dbt';

function setHasCodeCells(editor: vscode.TextEditor | undefined): void {
	let value = false;
	if (editor && editor.document.languageId === 'ggsql') {
		value = parseCells(editor.document).length > 0;
	}
	vscode.commands.executeCommand('setContext', 'ggsql.hasCodeCells', value);
}

const DBT_LANGUAGES = new Set(['sql', 'jinja-sql']);
// dbt_project.yml lookups hit the filesystem; cache them per directory.
const dbtProjectRootCache = new Map<string, string | undefined>();

function setIsDbtVisualiseFile(editor: vscode.TextEditor | undefined): void {
	let value = false;
	const document = editor?.document;
	if (
		document &&
		DBT_LANGUAGES.has(document.languageId) &&
		document.uri.scheme === 'file' &&
		splitVisualise(document.getText()) !== undefined
	) {
		const dir = path.dirname(document.uri.fsPath);
		if (!dbtProjectRootCache.has(dir)) {
			dbtProjectRootCache.set(dir, findDbtProjectRoot(dir));
		}
		value = dbtProjectRootCache.get(dir) !== undefined;
	}
	vscode.commands.executeCommand('setContext', 'ggsql.isDbtVisualiseFile', value);
}

export function activateContextKeys(disposables: vscode.Disposable[]): void {
	let activeEditor = vscode.window.activeTextEditor;
	setHasCodeCells(activeEditor);
	setIsDbtVisualiseFile(activeEditor);

	disposables.push(
		vscode.window.onDidChangeActiveTextEditor(editor => {
			activeEditor = editor;
			setHasCodeCells(editor);
			setIsDbtVisualiseFile(editor);
		}),
		vscode.workspace.onDidChangeTextDocument(event => {
			if (activeEditor && event.document === activeEditor.document) {
				setHasCodeCells(activeEditor);
				setIsDbtVisualiseFile(activeEditor);
			}
		}),
	);
}
