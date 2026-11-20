import * as vscode from "vscode";
import type { Controller } from "./controller";
import { classify } from "./files";
import { statusView } from "./status";

export const SHOW_FILE_PROBLEMS = "kovallent.showFileProblems";
export const SHOW_SETUP_PROBLEM = "kovallent.showSetupProblem";

/** One item for the active file, from its `run.files` entry. */
export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem("kovallent.status", vscode.StatusBarAlignment.Left, 50);
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly controller: Controller) {
    this.item.name = "kv-cli";
    this.subscriptions.push(
      controller.onDidChange(() => this.update()),
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      vscode.window.onDidChangeActiveNotebookEditor(() => this.update()),
    );
    this.update();
  }

  get text(): string | undefined {
    return this.visible ? this.item.text : undefined;
  }

  get tooltip(): string | undefined {
    return typeof this.item.tooltip === "string" ? this.item.tooltip : this.item.tooltip?.value;
  }

  get command(): vscode.Command | undefined {
    const c = this.item.command;
    return typeof c === "string" ? { command: c, title: c } : c;
  }

  visible = false;

  update(): void {
    const uri = activeFileUri();
    if (!uri || uri.scheme !== "file" || !classify(uri.fsPath)) {
      this.hide();
      return;
    }
    const b = this.controller.binary;
    if (b.kind === "missing" || b.kind === "tooOld" || b.kind === "broken") {
      this.item.text = b.kind === "missing" ? "$(warning) kv-cli: not found" : b.kind === "tooOld" ? `$(warning) kv-cli ${b.version.text}: too old` : "$(warning) kv-cli: not working";
      this.item.tooltip = "Click for details.";
      this.item.command = SHOW_SETUP_PROBLEM;
      this.show();
      return;
    }
    const state = this.controller.stateOf(uri);
    if (!state) {
      this.hide();
      return;
    }
    const view = statusView(state);
    this.item.text = view.text;
    this.item.tooltip = view.tooltip;
    this.item.command = { command: SHOW_FILE_PROBLEMS, title: "Show problems", arguments: [uri] };
    this.show();
  }

  private show() {
    this.visible = true;
    this.item.show();
  }

  private hide() {
    this.visible = false;
    this.item.hide();
  }

  dispose(): void {
    this.item.dispose();
    for (const s of this.subscriptions) {
      s.dispose();
    }
  }
}

/** The active editor's file; for a notebook cell, the notebook's file. */
export function activeFileUri(): vscode.Uri | undefined {
  const nb = vscode.window.activeNotebookEditor;
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme !== "vscode-notebook-cell") {
    return editor.document.uri;
  }
  return nb?.notebook.uri ?? editor?.document.uri;
}
