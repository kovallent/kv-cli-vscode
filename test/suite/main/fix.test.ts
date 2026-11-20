import * as assert from "assert";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { APPLY_FIX_BUTTON, PREVIEW_SCHEME } from "../../../src/controller";
import { FIX_TITLE } from "../../../src/extension";
import {
  api,
  audited,
  clearInvocations,
  dismissAll,
  env,
  idle,
  recordedText,
  starts,
  waitFor,
  wsPath,
} from "../helpers";

const MANUAL =
  "manual: deploy.py:90 `password` has a hardcoded default; move the lookup into the body so it is read per call, not at import time";

function sha1(text: string | Buffer): string {
  return crypto.createHash("sha1").update(text).digest("hex");
}

async function fixTitles(uri: vscode.Uri, line: number): Promise<string[]> {
  const range = new vscode.Range(line, 0, line, 1);
  const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
    "vscode.executeCodeActionProvider",
    uri,
    range,
  );
  // Other providers (VS Code's own chat actions, for one) may offer actions too.
  return (actions ?? []).map((a) => a.title).filter((t) => t === FIX_TITLE);
}

function fixCalls(): string[][] {
  return starts()
    .filter((c) => c.args[0] === "fix")
    .map((c) => c.args);
}

suite("Fix", () => {
  const original = () => fs.readFileSync(path.join(env("KV_TEST_SAMPLES"), "deploy.py"), "utf8");

  teardown(async () => {
    const a = await api();
    dismissAll(a);
    // Put deploy.py back for the next test.
    if (fs.readFileSync(wsPath("deploy.py"), "utf8") !== original()) {
      fs.writeFileSync(wsPath("deploy.py"), original());
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === wsPath("deploy.py"));
      if (doc) {
        await waitFor("deploy.py to reload", () => doc.getText() === original() && !doc.isDirty);
        a.controller.schedule(doc.uri, 0);
      }
    }
    await idle(a);
  });

  test("the fix action is offered on KV001 and KV002, never on KV003 or KV004", async () => {
    const a = await api();
    const deploy = await audited(a, "deploy.py");
    assert.deepStrictEqual(await fixTitles(deploy.document.uri, 10), [FIX_TITLE], "KV002 on line 11");
    assert.deepStrictEqual(await fixTitles(deploy.document.uri, 19), [FIX_TITLE], "KV001 on line 20");

    const job = await audited(a, "orders_job.py");
    assert.deepStrictEqual(await fixTitles(job.document.uri, 6), [], "KV004 on line 7");
    assert.deepStrictEqual(await fixTitles(job.document.uri, 8), [], "KV003 on line 9");

    const model = await audited(a, "dbt/models/session.sql");
    assert.deepStrictEqual(await fixTitles(model.document.uri, 0), [], "KV003 in a dbt model");
  });

  test("fix runs --dry-run first and does nothing if the user cancels", async () => {
    const a = await api();
    const editor = await audited(a, "deploy.py");
    const before = fs.readFileSync(wsPath("deploy.py"));
    clearInvocations();
    const previews: string[] = [];
    const sub = vscode.workspace.onDidOpenTextDocument((d) => {
      if (d.uri.scheme === PREVIEW_SCHEME) {
        previews.push(d.getText());
      }
    });
    a.ui.responder = (p) => (p.modal ? undefined : "pending");
    try {
      await vscode.commands.executeCommand("kovallent.fixFile", editor.document.uri);
    } finally {
      sub.dispose();
    }

    assert.deepStrictEqual(fixCalls(), [["fix", "--dry-run", "--", "deploy.py"]], "no write after a cancel");
    assert.ok(fs.readFileSync(wsPath("deploy.py")).equals(before), "deploy.py is untouched");
    assert.strictEqual(editor.document.isDirty, false);

    assert.deepStrictEqual(previews, [recordedText("fix-dry-run.stdout").trimEnd() + "\n"], "the dry run's output, as printed");
    const confirm = a.ui.recorded.find((p) => p.modal);
    assert.ok(confirm);
    assert.strictEqual(confirm.text, "Apply kv-cli fix to deploy.py?");
    assert.deepStrictEqual(confirm.buttons, [APPLY_FIX_BUTTON]);
    assert.ok(confirm.detail?.includes(`kv-cli fix leaves these for a person:\n${MANUAL}`), confirm.detail);
  });

  test("fix saves a dirty file, previews, and only then lets kv-cli write it", async () => {
    const a = await api();
    const editor = await audited(a, "deploy.py");
    await editor.edit((e) => e.insert(new vscode.Position(0, 0), "# edited before fixing\n"));
    assert.ok(editor.document.isDirty);
    const edited = editor.document.getText();
    clearInvocations();
    a.ui.responder = (p) => (p.modal ? APPLY_FIX_BUTTON : undefined);

    await vscode.commands.executeCommand("kovallent.fixFile", editor.document.uri);

    const calls = starts().filter((c) => c.args[0] === "fix");
    assert.deepStrictEqual(
      calls.map((c) => c.args),
      [
        ["fix", "--dry-run", "--", "deploy.py"],
        ["fix", "--", "deploy.py"],
      ],
    );
    assert.strictEqual(calls[0].targetSha, sha1(edited), "the file was saved before the dry run");

    // kv-cli wrote the file (the fake copies real kv-cli's output into place);
    // VS Code reloads it from disk.
    const fixed = recordedText("deploy.fixed.py");
    await waitFor("VS Code to reload deploy.py from disk", () => editor.document.getText() === fixed);
    assert.strictEqual(editor.document.isDirty, false);

    const done = a.ui.recorded.find((p) => !p.modal && p.kind === "info");
    assert.ok(done);
    assert.strictEqual(done.text, `kv-cli fix rewrote deploy.py. It left this for a person:\n${MANUAL}`);
    await idle(a);
    assert.ok(
      starts().some((c) => c.args[0] === "audit" && c.args.includes("deploy.py")),
      "the rewritten file is audited again",
    );
  });
});
