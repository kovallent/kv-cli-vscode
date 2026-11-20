import * as vscode from "vscode";
import { Controller, PREVIEW_SCHEME, SAVE_DEBOUNCE_MS } from "./controller";
import { diagnosticCode, FIXABLE_CODES, SOURCE } from "./diagnostics";
import { SHOW_FILE_PROBLEMS, SHOW_SETUP_PROBLEM, StatusBar } from "./statusBar";
import { Ui } from "./ui";

export const FIX_TITLE = "Apply kv-cli fix to this file";

/** Returned from activate() only under the extension test runner. */
export interface TestApi {
  controller: Controller;
  statusBar: StatusBar;
  ui: Ui;
}

export function activate(context: vscode.ExtensionContext): TestApi | undefined {
  const testMode = context.extensionMode === vscode.ExtensionMode.Test;
  const ui = new Ui(testMode);
  const output = vscode.window.createOutputChannel("Kovallent");
  const controller = new Controller(ui, output, context.globalState);
  const statusBar = new StatusBar(controller);

  context.subscriptions.push(
    output,
    controller,
    statusBar,
    vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, controller.previews),

    // On open and on save; never on a keystroke.
    vscode.workspace.onDidOpenTextDocument((doc) => controller.schedule(doc.uri, 0)),
    vscode.workspace.onDidSaveTextDocument((doc) => controller.schedule(doc.uri, SAVE_DEBOUNCE_MS)),
    vscode.workspace.onDidOpenNotebookDocument((nb) => controller.schedule(nb.uri, 0)),
    vscode.workspace.onDidSaveNotebookDocument((nb) => controller.schedule(nb.uri, SAVE_DEBOUNCE_MS)),
    vscode.workspace.onDidDeleteFiles((e) => e.files.forEach((uri) => controller.forget(uri))),
    vscode.workspace.onDidRenameFiles((e) =>
      e.files.forEach(({ oldUri, newUri }) => {
        controller.forget(oldUri);
        controller.schedule(newUri, 0);
      }),
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("kovallent.path")) {
        void controller.redetect();
      } else if (e.affectsConfiguration("kovallent.config")) {
        controller.auditOpenDocuments();
      }
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void controller.redetect()),

    vscode.commands.registerCommand("kovallent.auditWorkspace", () => controller.auditWorkspace()),
    vscode.commands.registerCommand("kovallent.fixFile", (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      return target && target.scheme === "file" ? controller.fixFile(target) : undefined;
    }),
    vscode.commands.registerCommand(SHOW_FILE_PROBLEMS, () =>
      vscode.commands.executeCommand("workbench.actions.view.problems"),
    ),
    vscode.commands.registerCommand(SHOW_SETUP_PROBLEM, () => controller.showBinaryProblem()),
    vscode.languages.registerCodeActionsProvider({ scheme: "file" }, new FixActions(), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),
  );

  void controller.detect().then(() => controller.auditOpenDocuments());

  return testMode ? { controller, statusBar, ui } : undefined;
}

export function deactivate(): void {}

/** Offered on KV001 and KV002 only: `fix` never rewrites KV003 or KV004. */
class FixActions implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    if (document.uri.scheme !== "file") {
      return [];
    }
    const fixable = context.diagnostics.filter(
      (d) => d.source === SOURCE && FIXABLE_CODES.has(diagnosticCode(d) ?? ""),
    );
    if (fixable.length === 0) {
      return [];
    }
    const action = new vscode.CodeAction(FIX_TITLE, vscode.CodeActionKind.QuickFix);
    action.diagnostics = fixable;
    action.command = { command: "kovallent.fixFile", title: FIX_TITLE, arguments: [document.uri] };
    return [action];
  }
}
