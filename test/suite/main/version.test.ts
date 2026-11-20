import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  api,
  audited,
  clearInvocations,
  clearScenario,
  dismissAll,
  env,
  idle,
  setScenario,
  sleep,
  starts,
  waitFor,
  wsPath,
} from "../helpers";

const SQL_NOTICE = "kv-cli 0.13.0 is older than 0.14.0, so dbt SQL models won't be checked.";

async function setPath(value: string | undefined, target = vscode.ConfigurationTarget.Global): Promise<void> {
  await vscode.workspace.getConfiguration("kovallent").update("path", value, target);
}

suite("kv-cli version and kovallent.path", () => {
  teardown(async () => {
    const a = await api();
    clearScenario();
    await setPath(undefined, vscode.ConfigurationTarget.Workspace);
    await setPath(undefined);
    await waitFor("kv-cli 0.14.0 on PATH again", () => {
      const b = a.controller.binary;
      return b.kind === "ready" && b.version.text === "0.14.0" && b.path === path.join(env("KV_FAKE_DIR"), "kv-cli");
    });
    await idle(a);
    dismissAll(a);
  });

  test("older than 0.9.0: says so and runs nothing", async () => {
    const a = await api();
    setScenario({ version: "0.8.0" });
    await setPath(path.join(env("KV_FAKE_DIR"), "kv-cli"));
    await waitFor("kv-cli 0.8.0 to be refused", () => a.controller.binary.kind === "tooOld");
    const errors = a.ui.recorded.filter((p) => p.kind === "error");
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].text, /^kv-cli 0\.8\.0 is older than 0\.9\.0/);

    clearInvocations();
    const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(wsPath("compliant.py")));
    await editor.document.save();
    a.controller.schedule(editor.document.uri, 0);
    await sleep(500);
    await idle(a);
    assert.deepStrictEqual(starts(), [], "nothing ran");
    assert.strictEqual(vscode.languages.getDiagnostics(editor.document.uri).length, 0);
    assert.strictEqual(a.statusBar.text, "$(warning) kv-cli 0.8.0: too old");
  });

  test("older than 0.14.0: works, and says once that dbt SQL models won't be checked", async () => {
    const a = await api();
    setScenario({ version: "0.13.0" });
    await setPath("kv-cli");
    await waitFor("kv-cli 0.13.0", () => {
      const b = a.controller.binary;
      return b.kind === "ready" && b.version.text === "0.13.0";
    });
    await waitFor("the SQL notice", () => a.ui.recorded.some((p) => p.text.startsWith(SQL_NOTICE)));

    clearInvocations();
    const model = await audited(a, "dbt/models/unparsed.sql");
    assert.strictEqual(a.statusBar.text, "kv-cli: SQL not checked");
    assert.ok(!starts().some((c) => c.args.some((x) => x.endsWith(".sql"))), "no .sql file was passed to kv-cli");
    assert.strictEqual(vscode.languages.getDiagnostics(model.document.uri).length, 0);

    const deploy = await audited(a, "deploy.py");
    assert.strictEqual(vscode.languages.getDiagnostics(deploy.document.uri).length, 19, "Python is still checked");

    // Finding the same release again does not repeat the notice.
    await setPath(path.join(env("KV_FAKE_DIR"), "kv-cli"));
    await waitFor("kv-cli 0.13.0 again", () => a.controller.binary.kind === "ready");
    await idle(a);
    assert.strictEqual(a.ui.recorded.filter((p) => p.text.startsWith(SQL_NOTICE)).length, 1);
  });

  test("a workspace-level kovallent.path is used in a trusted workspace", async () => {
    const a = await api();
    assert.strictEqual(vscode.workspace.isTrusted, true);
    await setPath("./trap/kv-cli", vscode.ConfigurationTarget.Workspace);
    await waitFor("the workspace-level path", () => {
      const b = a.controller.binary;
      return b.kind === "ready" && b.path === wsPath("trap/kv-cli");
    });
    assert.ok(fs.existsSync(env("KV_TRAP_MARKER")), "the workspace-level binary ran");
  });
});
