import * as assert from "assert";
import * as vscode from "vscode";
import { COULD_NOT_AUDIT } from "../../../src/diagnostics";
import {
  api,
  audited,
  clearInvocations,
  clearScenario,
  dismissAll,
  idle,
  recordedPayload,
  setScenario,
  setSetting,
  starts,
  statusReads,
  waitFor,
} from "../helpers";

const { Workspace } = vscode.ConfigurationTarget;

suite("Exit codes", () => {
  teardown(async () => {
    const a = await api();
    await setSetting("config", undefined, Workspace);
    await idle(a);
    dismissAll(a);
  });

  test("exit 2 clears diagnostics and shows the error", async () => {
    const a = await api();
    const editor = await audited(a, "deploy.py");
    const uri = editor.document.uri;
    assert.strictEqual(vscode.languages.getDiagnostics(uri).length, recordedPayload("fail").findings.length);
    dismissAll(a);
    clearInvocations();

    // A contract that does not exist: real kv-cli 0.14.0 exits 2 with
    // "error: contract not found: missing.yaml" (test/fixtures/recorded).
    // Once the change reaches the extension, every open file is due for an
    // audit; idle means all of them have answered.
    await setSetting("config", "missing.yaml", Workspace);
    await waitFor("deploy.py to show the tool error", () => a.controller.stateOf(uri)?.kind === "error");
    await idle(a);

    const call = starts().find((c) => c.args.includes("deploy.py"));
    assert.deepStrictEqual(call?.args, ["audit", "--format", "json", "--config", "missing.yaml", "--", "deploy.py"]);

    const diagnostics = vscode.languages.getDiagnostics(uri);
    assert.strictEqual(diagnostics.length, 1, "the stale findings are gone");
    const [d] = diagnostics;
    assert.strictEqual(d.message.split("\n")[0], COULD_NOT_AUDIT);
    assert.strictEqual(d.range.start.line, 0);
    assert.strictEqual(d.source, "kv-cli");

    const errors = a.ui.recorded.filter((p) => p.kind === "error");
    assert.strictEqual(errors.length, 1, `a single error notification, however many files failed: ${JSON.stringify(errors.map((e) => e.text))}`);
    assert.strictEqual(errors[0].text, "kv-cli: error: contract not found: missing.yaml");
    await statusReads(a, "$(error) kv-cli: could not audit");

    await setSetting("config", undefined, Workspace);
    await waitFor("deploy.py's findings to come back", () => vscode.languages.getDiagnostics(uri).length === 19);
    await idle(a);
  });

  test("exit 3 is a tool error even though a payload came with it", async () => {
    const a = await api();
    const editor = await audited(a, "deploy.py");
    const uri = editor.document.uri;
    dismissAll(a);
    // Real kv-cli 0.14.0 output for --expect-contract with the wrong
    // fingerprint: a full payload on stdout, exit 3, nothing on stderr.
    setScenario({ replay: "contract-drift" });
    try {
      a.controller.schedule(uri, 0);
      await waitFor("deploy.py to show the tool error", () => a.controller.stateOf(uri)?.kind === "error");
      await idle(a);
      const diagnostics = vscode.languages.getDiagnostics(uri);
      assert.strictEqual(diagnostics.length, 1);
      assert.deepStrictEqual(diagnostics[0].message.split("\n"), [COULD_NOT_AUDIT, "exited with code 3 (contract drift)"]);
      assert.deepStrictEqual(
        a.ui.recorded.filter((p) => p.kind === "error").map((p) => p.text),
        ["kv-cli: exited with code 3 (contract drift)"],
      );
    } finally {
      clearScenario();
    }
    a.controller.schedule(uri, 0);
    await waitFor("deploy.py's findings to come back", () => vscode.languages.getDiagnostics(uri).length === 19);
  });
});
