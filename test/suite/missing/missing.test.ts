import * as assert from "assert";
import * as vscode from "vscode";
import { COPY_PIP_BUTTON, OPEN_INSTALL_BUTTON, PIP_INSTALL } from "../../../src/controller";
import { api, idle, invocations, statusReads, waitFor, wsUri } from "../helpers";

// Launched with no kv-cli on PATH and kovallent.path unset.
suite("Missing kv-cli", () => {
  test("a missing binary shows the install notification and runs nothing", async () => {
    const a = await api();
    await waitFor("kv-cli to be reported missing", () => a.controller.binary.kind === "missing");

    const doc = await vscode.workspace.openTextDocument(wsUri("deploy.py"));
    await vscode.window.showTextDocument(doc);
    a.controller.schedule(doc.uri, 0);
    // Idle once the scheduled audit has run and found no kv-cli.
    await idle(a);

    assert.deepStrictEqual(
      a.ui.recorded.map((p) => [p.kind, p.text, p.buttons]),
      [
        [
          "warning",
          "kv-cli was not found on PATH. The Kovallent extension runs your own kv-cli and never downloads one.",
          [COPY_PIP_BUTTON, OPEN_INSTALL_BUTTON],
        ],
      ],
      "exactly one notification, with both buttons",
    );
    assert.deepStrictEqual(invocations(), [], "the fake kv-cli (not on PATH) never ran");
    assert.deepStrictEqual(vscode.languages.getDiagnostics(doc.uri), []);
    await statusReads(a, "$(warning) kv-cli: not found");

    await vscode.env.clipboard.writeText("");
    a.ui.recorded[0].answer(COPY_PIP_BUTTON);
    await waitFor("the install command on the clipboard", async () => (await vscode.env.clipboard.readText()) === PIP_INSTALL);
  });

  test("Audit workspace runs nothing either", async () => {
    const a = await api();
    a.ui.recorded.length = 0;
    a.ui.responder = () => undefined;
    await vscode.commands.executeCommand("kovallent.auditWorkspace");
    assert.deepStrictEqual(invocations(), []);
    assert.strictEqual(a.ui.recorded.length, 1);
    assert.deepStrictEqual(a.ui.recorded[0].buttons, [COPY_PIP_BUTTON, OPEN_INSTALL_BUTTON]);
  });
});
