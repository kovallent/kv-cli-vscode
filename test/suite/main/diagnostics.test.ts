import * as assert from "assert";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { SAVE_DEBOUNCE_MS } from "../../../src/controller";
import type { TestApi } from "../../../src/extension";
import { FakeClock } from "../fakeClock";
import {
  api,
  audited,
  clearInvocations,
  clearScenario,
  dismissAll,
  env,
  idle,
  invocations,
  recordedPayload,
  setScenario,
  starts,
  statusReads,
  waitFor,
  wsPath,
  wsUri,
} from "../helpers";

function sha1(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex");
}

/** The fake kv-cli's audits of `rel`, in order. */
function auditsOf(rel: string) {
  return starts().filter((c) => c.args[0] === "audit" && c.args.includes(rel));
}

/**
 * Replace the file's text and save it, then wait until the extension has
 * scheduled the audit that save asks for: due SAVE_DEBOUNCE_MS from now on
 * the fake clock. Returns the text saved.
 */
async function saveOnFakeClock(a: TestApi, editor: vscode.TextEditor, clock: FakeClock, text: string): Promise<string> {
  const doc = editor.document;
  await editor.edit((e) => e.replace(new vscode.Range(0, 0, doc.lineCount, 0), text));
  assert.ok(await doc.save(), "the save went through");
  const due = clock.now() + SAVE_DEBOUNCE_MS;
  await waitFor(
    () => `the save's audit to be due at ${due}; it is due at ${a.controller.auditDue(doc.uri)}`,
    () => a.controller.auditDue(doc.uri) === due,
  );
  // The debounce itself: an earlier save's timer is gone, not just outrun.
  // (Counting kv-cli runs alone can't show this: a superseded run is killed,
  // often before the fake kv-cli logs anything.)
  assert.strictEqual(clock.pending, 1, "one timer waits, for the last save");
  return text;
}

/** Run `body` with the debouncer on a fake clock, then flush it and go back to real time. */
async function onFakeClock(a: TestApi, body: (clock: FakeClock) => Promise<void>): Promise<void> {
  const clock = new FakeClock();
  a.clock.use(clock);
  try {
    await body(clock);
  } finally {
    clock.runAll();
    a.clock.reset();
    await idle(a);
  }
}

/**
 * Put a sample back as it was, through the editor rather than behind VS
 * Code's back, and wait for the audit of the restored text: nothing is left
 * running into the next test.
 */
async function restore(a: TestApi, rel: string, doc: vscode.TextDocument): Promise<void> {
  const original = fs.readFileSync(path.join(env("KV_TEST_SAMPLES"), rel), "utf8");
  if (doc.getText() === original && !doc.isDirty) {
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), original);
  assert.ok(await vscode.workspace.applyEdit(edit), `${rel} edited back`);
  assert.ok(await doc.save(), `${rel} saved back`);
  await waitFor(`the audit of the restored ${rel}`, () =>
    auditsOf(rel).some((c) => c.targetSha === sha1(original)) && a.controller.idle,
  );
}

function kvDiagnostics(uri: vscode.Uri): vscode.Diagnostic[] {
  return vscode.languages.getDiagnostics(uri).filter((d) => d.source === "kv-cli");
}

function codeOf(d: vscode.Diagnostic): { value: string; target?: string } {
  if (typeof d.code === "object" && d.code !== null) {
    return { value: String(d.code.value), target: d.code.target.toString() };
  }
  return { value: String(d.code) };
}

suite("Diagnostics", () => {
  teardown(async () => dismissAll(await api()));

  test("diagnostics match the payload's findings line for line", async () => {
    const a = await api();
    const editor = await audited(a, "deploy.py");
    const payload = recordedPayload("fail");
    const diagnostics = kvDiagnostics(editor.document.uri);
    const lines = fs.readFileSync(wsPath("deploy.py"), "utf8").split("\n");

    assert.strictEqual(payload.findings.length, 19);
    assert.strictEqual(diagnostics.length, payload.findings.length, "one diagnostic per finding");
    payload.findings.forEach((f, i) => {
      const d = diagnostics[i];
      const text = lines[f.line - 1];
      assert.strictEqual(d.range.start.line, f.line - 1, `finding ${i} line`);
      assert.strictEqual(d.range.end.line, f.line - 1);
      assert.strictEqual(d.range.start.character, text.search(/\S/), "starts at the first non-whitespace character");
      assert.strictEqual(d.range.end.character, text.trimEnd().length, "ends at the last non-whitespace character");
      assert.strictEqual(d.message, `${f.message}\n${f.detail}`);
      assert.strictEqual(
        d.severity,
        f.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
      );
      assert.deepStrictEqual(codeOf(d), {
        value: f.code,
        target: `https://github.com/kovallent/kv-cli/blob/v0.14.0/docs/rules/${f.code}.md`,
      });
    });
  });

  test("KV002 details are shown exactly as redacted by kv-cli", async () => {
    const a = await api();
    const editor = await audited(a, "deploy.py");
    const kv002 = kvDiagnostics(editor.document.uri).filter((d) => codeOf(d).value === "KV002");
    assert.strictEqual(kv002.length, 7);
    const source = fs.readFileSync(wsPath("deploy.py"), "utf8");
    assert.ok(source.includes("s3cr3t-production-pw"), "the sample really holds the credential");
    for (const d of kv002) {
      assert.match(d.message, /<redacted>/);
      assert.ok(!d.message.includes("s3cr3t-production-pw"));
      assert.ok(!d.message.includes("AKIAIOSFODNN7EXAMPLE"));
    }
  });

  test("warnings stay warnings: --strict is never passed", async () => {
    const a = await api();
    const editor = await audited(a, "orders_job.py");
    const diagnostics = kvDiagnostics(editor.document.uri);
    assert.deepStrictEqual(
      diagnostics.map((d) => [codeOf(d).value, d.severity]),
      [
        ["KV004", vscode.DiagnosticSeverity.Warning],
        ["KV003", vscode.DiagnosticSeverity.Warning],
      ],
    );
    assert.ok(invocations().every((i) => !i.args.includes("--strict")));
  });

  for (const [rel, reason] of [
    ["broken.py", "syntax_error"],
    ["dbt/models/unparsed.sql", "sql_not_parsed"],
  ]) {
    test(`a skipped file (${reason}) gets one Information diagnostic at line 1`, async () => {
      const a = await api();
      const editor = await audited(a, rel);
      const diagnostics = kvDiagnostics(editor.document.uri);
      assert.strictEqual(diagnostics.length, 1);
      const [d] = diagnostics;
      assert.strictEqual(d.severity, vscode.DiagnosticSeverity.Information);
      assert.strictEqual(d.range.start.line, 0);
      assert.strictEqual(d.message.split("\n")[0], `kv-cli did not fully check this file: ${reason}`);
      // Never shown as clean.
      await statusReads(a, `$(warning) kv-cli: skipped (${reason})`);
    });
  }

  test("audits run in the workspace folder, pass the file after --, and never pass --config", async () => {
    const a = await api();
    const editor = await audited(a, "compliant.py");
    clearInvocations();
    a.controller.schedule(editor.document.uri, 0);
    await waitFor("one audit of compliant.py, finished", () => auditsOf("compliant.py").length === 1 && a.controller.idle);
    const calls = starts();
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].cwd, env("KV_TEST_WORKSPACE"));
    assert.deepStrictEqual(calls[0].args, ["audit", "--format", "json", "--", "compliant.py"]);
  });

  // The debounce, on a fake clock: the test decides how far apart saves are,
  // so nothing depends on how fast the machine runs.
  test("three saves 100 ms apart run kv-cli once, on the last save's content", async () => {
    const a = await api();
    const editor = await audited(a, "compliant.py");
    const original = editor.document.getText();
    clearInvocations();
    try {
      await onFakeClock(a, async (clock) => {
        await saveOnFakeClock(a, editor, clock, `${original}# save 1\n`);
        clock.advance(100);
        await saveOnFakeClock(a, editor, clock, `${original}# save 2\n`);
        clock.advance(100);
        const last = await saveOnFakeClock(a, editor, clock, `${original}# save 3\n`);
        assert.deepStrictEqual(auditsOf("compliant.py"), [], "nothing runs inside the window");

        clock.advance(SAVE_DEBOUNCE_MS);
        assert.strictEqual(clock.pending, 0, "the one timer fired");
        await waitFor("the debounced audit to finish", () => auditsOf("compliant.py").length > 0 && a.controller.idle);
        const runs = auditsOf("compliant.py");
        assert.strictEqual(runs.length, 1, "one run for three saves");
        assert.strictEqual(runs[0].targetSha, sha1(last), "kv-cli read the last save's content");
      });
    } finally {
      await restore(a, "compliant.py", editor.document);
    }
  });

  test("two saves 400 ms apart run kv-cli twice", async () => {
    const a = await api();
    const editor = await audited(a, "compliant.py");
    const original = editor.document.getText();
    clearInvocations();
    try {
      await onFakeClock(a, async (clock) => {
        const first = await saveOnFakeClock(a, editor, clock, `${original}# save A\n`);
        clock.advance(400);
        await waitFor("the first audit to finish", () => auditsOf("compliant.py").length === 1 && a.controller.idle);
        const second = await saveOnFakeClock(a, editor, clock, `${original}# save B\n`);
        clock.advance(400);
        await waitFor("the second audit to finish", () => auditsOf("compliant.py").length === 2 && a.controller.idle);
        assert.deepStrictEqual(
          auditsOf("compliant.py").map((r) => r.targetSha),
          [sha1(first), sha1(second)],
        );
      });
    } finally {
      await restore(a, "compliant.py", editor.document);
    }
  });

  // On real timers, with no assertion about time.
  test("a save runs kv-cli exactly once", async () => {
    const a = await api();
    const editor = await audited(a, "compliant.py");
    const original = editor.document.getText();
    clearInvocations();
    try {
      await editor.edit((e) => e.insert(new vscode.Position(editor.document.lineCount, 0), "# saved\n"));
      assert.ok(await editor.document.save(), "the save went through");
      await waitFor("the save's audit to finish", () => auditsOf("compliant.py").length > 0 && a.controller.idle);
      // Idle means no audit is waiting or running, so no further run can come.
      assert.strictEqual(auditsOf("compliant.py").length, 1);
      assert.strictEqual(auditsOf("compliant.py")[0].targetSha, sha1(`${original}# saved\n`));
    } finally {
      await restore(a, "compliant.py", editor.document);
    }
  });

  test("a run superseded by a newer one is cancelled", async () => {
    const a = await api();
    const editor = await audited(a, "orders_job.py");
    const uri = editor.document.uri;
    clearInvocations();
    // Every audit waits for this file before it answers: the first run is
    // still running when the second starts, however slow the machine.
    const release = path.join(path.dirname(env("KV_FAKE_LOG")), "release-superseded");
    fs.rmSync(release, { force: true });
    setScenario({ holdUntil: release });
    try {
      a.controller.schedule(uri, 0);
      await waitFor("the first run to start", () => auditsOf("orders_job.py").length === 1);
      a.controller.schedule(uri, 0);
      await waitFor("the second run to start", () => auditsOf("orders_job.py").length === 2);
      const [first, second] = auditsOf("orders_job.py");
      await waitFor("the first run to be killed", () =>
        invocations().some((e) => e.event === "killed" && e.pid === first.pid),
      );
      assert.ok(!invocations().some((e) => e.event === "exit"), "neither run has answered yet");

      fs.writeFileSync(release, "");
      await waitFor("the second run to finish", () =>
        invocations().some((e) => e.event === "exit" && e.pid === second.pid) && a.controller.idle,
      );
      assert.ok(!invocations().some((e) => e.event === "exit" && e.pid === first.pid), "the first run never answered");
      assert.strictEqual(kvDiagnostics(uri).length, 2, "the second run's findings");
    } finally {
      clearScenario();
      fs.writeFileSync(release, "");
    }
  });

  test("Kovallent: Audit workspace fills the Problems panel", async () => {
    const a = await api();
    const notOpened = wsUri("dbt/models/session.sql");
    assert.ok(!vscode.workspace.textDocuments.some((d) => d.uri.toString() === notOpened.toString()));
    clearInvocations();
    await vscode.commands.executeCommand("kovallent.auditWorkspace");
    await idle(a);

    const calls = starts();
    assert.deepStrictEqual(
      calls.map((c) => [c.args, c.cwd]),
      [[["audit", "--format", "json", "--", "."], env("KV_TEST_WORKSPACE")]],
    );
    const payload = recordedPayload("workspace");
    for (const file of payload.run.files) {
      const uri = wsUri(file.path);
      const expected =
        payload.findings.filter((f) => f.path === file.path).length +
        payload.run.skipped.filter((s) => s.path === file.path).length;
      assert.strictEqual(kvDiagnostics(uri).length, expected, file.path);
    }
    assert.strictEqual(kvDiagnostics(notOpened).length, 2);
  });
});
