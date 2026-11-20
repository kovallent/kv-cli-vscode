import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { api, audited, env, invocations } from "../helpers";

// Launched with workspace trust on and the folder untrusted. The workspace's
// .vscode/settings.json sets kovallent.path to ./trap/kv-cli, which records
// that it ran; the fake kv-cli is on PATH.
suite("Untrusted workspace", () => {
  test("an untrusted workspace ignores a workspace-level kovallent.path", async () => {
    assert.strictEqual(vscode.workspace.isTrusted, false, "the folder opened in restricted mode");
    const settings = JSON.parse(fs.readFileSync(path.join(env("KV_TEST_WORKSPACE"), ".vscode", "settings.json"), "utf8"));
    assert.strictEqual(settings["kovallent.path"], "./trap/kv-cli", "the workspace really sets kovallent.path");
    assert.ok(fs.existsSync(path.join(env("KV_TEST_WORKSPACE"), "trap", "kv-cli")));

    const a = await api();
    const editor = await audited(a, "deploy.py");
    const b = a.controller.binary;
    assert.strictEqual(b.kind, "ready");
    assert.strictEqual(b.kind === "ready" && b.path, path.join(env("KV_FAKE_DIR"), "kv-cli"), "kv-cli from PATH");

    assert.ok(!fs.existsSync(env("KV_TRAP_MARKER")), "the workspace-level binary never ran");
    assert.ok(invocations().some((i) => i.args[0] === "--version"));
    assert.strictEqual(vscode.languages.getDiagnostics(editor.document.uri).length, 19);
  });
});
