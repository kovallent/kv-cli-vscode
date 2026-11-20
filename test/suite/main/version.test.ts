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
  setSetting,
  starts,
  statusReads,
  waitFor,
  wsPath,
} from "../helpers";

const SQL_NOTICE = "kv-cli 0.13.0 is older than 0.14.0, so dbt SQL models won't be checked.";
const FAKE = () => path.join(env("KV_FAKE_DIR"), "kv-cli");
const { Global, Workspace } = vscode.ConfigurationTarget;

/** The `--version` calls the fake kv-cli received. */
function versionChecks() {
  return starts().filter((c) => c.args[0] === "--version");
}

// Each change to kovallent.path makes the extension find kv-cli again. The
// tests wait for the configuration event, then for the `--version` call it
// causes, then for idle: a check that passed on the previous binary's state
// can't pass by accident.
suite("kv-cli version and kovallent.path", () => {
  teardown(async () => {
    const a = await api();
    clearScenario();
    await setSetting("path", undefined, Workspace);
    await idle(a);
    await setSetting("path", undefined, Global);
    await waitFor("kv-cli 0.14.0 on PATH again", () => {
      const b = a.controller.binary;
      return b.kind === "ready" && b.version.text === "0.14.0" && b.path === FAKE();
    });
    await idle(a);
    dismissAll(a);
  });

  test("older than 0.9.0: says so and runs nothing", async () => {
    const a = await api();
    setScenario({ version: "0.8.0" });
    clearInvocations();
    await setSetting("path", FAKE(), Global);
    await waitFor("kv-cli 0.8.0 to be refused", () => a.controller.binary.kind === "tooOld");
    await idle(a);
    const errors = a.ui.recorded.filter((p) => p.kind === "error");
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0].text, /^kv-cli 0\.8\.0 is older than 0\.9\.0/);
    assert.deepStrictEqual(
      starts().map((c) => c.args),
      [["--version"]],
      "only the version check ran, though every open file was due for an audit",
    );

    const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(wsPath("compliant.py")));
    a.controller.schedule(editor.document.uri, 0);
    // Idle once the scheduled audit has run and found no usable kv-cli.
    await idle(a);
    assert.deepStrictEqual(starts().map((c) => c.args), [["--version"]], "still nothing but the version check");
    assert.strictEqual(vscode.languages.getDiagnostics(editor.document.uri).length, 0);
    await statusReads(a, "$(warning) kv-cli 0.8.0: too old");
  });

  test("older than 0.14.0: works, and says once that dbt SQL models won't be checked", async () => {
    const a = await api();
    setScenario({ version: "0.13.0" });
    await setSetting("path", "kv-cli", Global);
    await waitFor("kv-cli 0.13.0", () => {
      const b = a.controller.binary;
      return b.kind === "ready" && b.version.text === "0.13.0";
    });
    // The notice follows a globalState write, so it can land after "ready".
    await waitFor("the SQL notice", () => a.ui.recorded.some((p) => p.text.startsWith(SQL_NOTICE)));
    await idle(a);

    clearInvocations();
    const model = await audited(a, "dbt/models/unparsed.sql");
    await statusReads(a, "kv-cli: SQL not checked");
    assert.ok(!starts().some((c) => c.args.some((x) => x.endsWith(".sql"))), "no .sql file was passed to kv-cli");
    assert.strictEqual(vscode.languages.getDiagnostics(model.document.uri).length, 0);

    const deploy = await audited(a, "deploy.py");
    assert.strictEqual(vscode.languages.getDiagnostics(deploy.document.uri).length, 19, "Python is still checked");

    // Finding the same release again does not repeat the notice.
    clearInvocations();
    await setSetting("path", FAKE(), Global);
    await waitFor("kv-cli 0.13.0 to be found again", () => {
      const b = a.controller.binary;
      return versionChecks().length === 1 && b.kind === "ready" && b.version.text === "0.13.0" && a.controller.idle;
    });
    // Whether to show it is decided before kv-cli reads as ready, so none can follow.
    assert.strictEqual(a.ui.recorded.filter((p) => p.text.startsWith(SQL_NOTICE)).length, 1);
  });

  test("a workspace-level kovallent.path is used in a trusted workspace", async () => {
    const a = await api();
    assert.strictEqual(vscode.workspace.isTrusted, true);
    await setSetting("path", "./trap/kv-cli", Workspace);
    await waitFor("the workspace-level path", () => {
      const b = a.controller.binary;
      return b.kind === "ready" && b.path === wsPath("trap/kv-cli");
    });
    assert.ok(fs.existsSync(env("KV_TRAP_MARKER")), "the workspace-level binary ran");
  });
});
