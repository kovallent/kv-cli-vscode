import * as assert from "assert";
import * as fs from "fs";
import * as vscode from "vscode";
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
  sleep,
  starts,
  waitFor,
  wsPath,
  wsUri,
} from "../helpers";

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
      assert.ok(!/clean/.test(a.statusBar.text ?? ""), "a skipped file is never shown as clean");
    });
  }

  test("audits run in the workspace folder, pass the file after --, and never pass --config", async () => {
    const a = await api();
    const editor = await audited(a, "compliant.py");
    clearInvocations();
    a.controller.schedule(editor.document.uri, 0);
    await sleep(50);
    await idle(a);
    const calls = starts();
    assert.strictEqual(calls.length, 1);
    for (const c of calls) {
      assert.strictEqual(c.cwd, env("KV_TEST_WORKSPACE"));
      assert.deepStrictEqual(c.args, ["audit", "--format", "json", "--", "compliant.py"]);
    }
  });

  test("saves are debounced to one run per file", async () => {
    const a = await api();
    const editor = await audited(a, "compliant.py");
    const original = editor.document.getText();
    clearInvocations();
    const saves: number[] = [];
    const sub = vscode.workspace.onDidSaveTextDocument((d) => {
      if (d === editor.document) {
        saves.push(Date.now());
      }
    });
    for (let i = 0; i < 3; i++) {
      await editor.edit((e) => e.insert(editor.document.lineAt(editor.document.lineCount - 1).range.end, "\n"));
      await editor.document.save();
    }
    sub.dispose();
    await sleep(400);
    await idle(a);
    const runs = starts().filter((i) => i.args.includes("compliant.py"));
    assert.strictEqual(saves.length, 3);
    assert.ok(saves[2] - saves[0] < 300, `three saves within the debounce window: ${saves.map((t) => t - saves[0])}`);
    assert.strictEqual(runs.length, 1, `runs at ${runs.map((r) => r.time - saves[0])} ms after the first save`);
    assert.ok(runs[0].time - saves[2] >= 250, "the run waits for the last save");

    fs.writeFileSync(wsPath("compliant.py"), original);
    await waitFor("compliant.py to reload", () => editor.document.getText() === original);
  });

  test("a run superseded by a newer one is cancelled", async () => {
    const a = await api();
    const editor = await audited(a, "orders_job.py");
    clearInvocations();
    setScenario({ delayMs: 1500 });
    try {
      a.controller.schedule(editor.document.uri, 0);
      await waitFor("the first run to start", () => starts().length === 1);
      a.controller.schedule(editor.document.uri, 0);
      await waitFor("the second run to start", () => starts().length === 2);
      await idle(a);
      const events = invocations();
      const [first, second] = starts();
      assert.ok(events.some((e) => e.event === "killed" && e.pid === first.pid), "the first run was killed");
      assert.ok(events.some((e) => e.event === "exit" && e.pid === second.pid), "the second run finished");
      assert.strictEqual(kvDiagnostics(editor.document.uri).length, 2);
    } finally {
      clearScenario();
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
