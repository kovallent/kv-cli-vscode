import * as assert from "assert";
import * as vscode from "vscode";
import { SHOW_FILE_PROBLEMS } from "../../../src/statusBar";
import { api, audited, dismissAll, recordedPayload, statusReads } from "../helpers";

suite("Status bar", () => {
  teardown(async () => dismissAll(await api()));

  const cases: Array<[string, string, string]> = [
    ["deploy.py", "fail", "kv-cli: 13 errors, 6 warnings"],
    ["compliant.py", "pass", "kv-cli: clean (3 enforced)"],
    ["dbt_model.py", "nothing-enforced", "kv-cli: nothing enforced"],
    ["config/pipeline.yml", "credentials-only-yaml", "kv-cli: credentials only"],
    ["orders_job.py", "warnings", "kv-cli: 2 warnings"],
    ["dbt/models/session.sql", "sql-model", "kv-cli: 2 warnings"],
    ["broken.py", "syntax-error", "$(warning) kv-cli: skipped (syntax_error)"],
    ["dbt/models/unparsed.sql", "sql-not-parsed", "$(warning) kv-cli: skipped (sql_not_parsed)"],
  ];

  for (const [rel, recording, expected] of cases) {
    test(`${rel}: "${expected}"`, async () => {
      const a = await api();
      await audited(a, rel);
      // The item follows the active editor, whose change event can arrive
      // after showTextDocument resolves: wait for it to read the expected text.
      await statusReads(a, expected);
      assert.ok(!/compliant/i.test(a.statusBar.text ?? ""), 'a single file is never "compliant"');
      assert.ok(!/compliant/i.test(a.statusBar.tooltip ?? ""));
      const entry = recordedPayload(recording).run.files[0];
      assert.ok(entry, `${recording} lists the file`);
    });
  }

  test('"nothing enforced" is a clean file whose enforced count is zero', () => {
    const entry = recordedPayload("nothing-enforced").run.files[0];
    assert.strictEqual(entry.status, "clean");
    assert.strictEqual(entry.analysis, "full");
    assert.strictEqual(entry.scope.functions_in_scope - entry.scope.functions_report_only, 0);
    assert.strictEqual(entry.scope.functions_exempt_framework, 1);
  });

  test("clicking the item opens the Problems panel for the file", async () => {
    const a = await api();
    await audited(a, "deploy.py");
    const command = a.statusBar.command;
    assert.strictEqual(command?.command, SHOW_FILE_PROBLEMS);
    await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
  });

  test("the item hides for a file kv-cli does not scan", async () => {
    const a = await api();
    const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: "# notes" });
    await vscode.window.showTextDocument(doc);
    await statusReads(a, undefined);
  });
});
