import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { expand, readPathSetting, resolveBinary, type PathSetting } from "./binary";
import {
  couldNotAuditDiagnostic,
  findingDiagnostic,
  linesOf,
  skippedDiagnostic,
  type LineReader,
} from "./diagnostics";
import { Debouncer, type Clock } from "./debounce";
import { classify } from "./files";
import { parsePayload, PayloadError, type FileResult, type Payload, type SkippedFile } from "./payload";
import { runKvCli, stripAnsi, type Run, type RunResult } from "./runner";
import type { FileState } from "./status";
import type { Ui } from "./ui";
import { isAtLeast, MIN_VERSION, parseVersion, SQL_VERSION, type Version } from "./version";

export const SAVE_DEBOUNCE_MS = 300;
export const INSTALL_URL = "https://github.com/kovallent/kv-cli#quickstart";
export const PIP_INSTALL = "pip install kv-cli";
export const COPY_PIP_BUTTON = `Copy "${PIP_INSTALL}"`;
export const OPEN_INSTALL_BUTTON = "Open install guide";
export const APPLY_FIX_BUTTON = "Apply fix";
export const PREVIEW_SCHEME = "kv-cli-fix";

export type BinaryState =
  | { kind: "checking" }
  | { kind: "ready"; path: string; version: Version; setting: PathSetting }
  | { kind: "missing"; looked: string; setting: PathSetting }
  | { kind: "tooOld"; path: string; version: Version }
  | { kind: "broken"; path: string; message: string };

type Outcome = { kind: "payload"; payload: Payload; exitCode: number } | { kind: "toolError"; message: string };

interface StoredState {
  state: FileState;
  /** When the run that produced it started, so an older run never overwrites a newer one. */
  startedAt: number;
}

interface Target {
  cwd: string;
  arg: string;
}

/**
 * Runs kv-cli and turns its JSON payload into diagnostics and per-file state.
 * kv-cli's exit codes are handled one by one: 0 and 1 carry a payload, 2 is
 * a tool error, and 3 (contract drift, which needs `--expect-contract`, never
 * passed here) is treated as a tool error too.
 */
export class Controller implements vscode.Disposable {
  readonly diagnostics = vscode.languages.createDiagnosticCollection("kv-cli");
  private readonly states = new Map<string, StoredState>();
  private readonly pending: Debouncer;
  private readonly inflight = new Map<string, { run: Run; startedAt: number }>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private binaryState: BinaryState = { kind: "checking" };
  private detection: Promise<void> = Promise.resolve();
  private busy = 0;
  readonly previews = new PreviewDocuments();

  /** `clock` is for tests; production passes nothing and gets the real timers. */
  constructor(
    private readonly ui: Ui,
    private readonly output: vscode.OutputChannel,
    private readonly globalState: vscode.Memento,
    clock?: Clock,
  ) {
    this.pending = new Debouncer(clock);
  }

  dispose(): void {
    this.pending.cancelAll();
    for (const r of this.inflight.values()) {
      r.run.cancel();
    }
    this.diagnostics.dispose();
    this.changeEmitter.dispose();
    this.previews.dispose();
  }

  get binary(): BinaryState {
    return this.binaryState;
  }

  stateOf(uri: vscode.Uri): FileState | undefined {
    return this.states.get(uri.toString())?.state;
  }

  /** No run waiting, running or detecting. For tests. */
  get idle(): boolean {
    return this.binaryState.kind !== "checking" && this.pending.size === 0 && this.inflight.size === 0 && this.busy === 0;
  }

  private log = (line: string) => this.output.appendLine(line);

  // ---------------------------------------------------------------- binary

  /** Find kv-cli and read its version. Nothing runs until this settles. */
  detect(): Promise<void> {
    this.detection = this.doDetect();
    return this.detection;
  }

  private async doDetect(): Promise<void> {
    this.binaryState = { kind: "checking" };
    this.changeEmitter.fire();
    const setting = readPathSetting(vscode.workspace.isTrusted);
    if (setting.ignoredWorkspaceValue) {
      this.log(
        `Untrusted workspace: ignoring the workspace-level kovallent.path "${setting.ignoredWorkspaceValue}"; ` +
          `using ${setting.value ? `"${setting.value}" from user settings` : "kv-cli on PATH"}.`,
      );
    }
    const resolved = resolveBinary(setting.value);
    if (!resolved.found) {
      this.binaryState = { kind: "missing", looked: resolved.looked, setting };
      this.log(`kv-cli not found (${resolved.looked}). Nothing will run.`);
      this.changeEmitter.fire();
      void this.showBinaryProblem();
      return;
    }
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
    const r = await runKvCli(resolved.path, ["--version"], cwd, this.log, 15_000).result;
    const version = r.exitCode === 0 ? parseVersion(r.stdout) : undefined;
    if (!version) {
      const why = r.spawnError?.message ?? (stripAnsi(r.stderr).trim() || `exit ${r.exitCode ?? r.signal}`);
      this.binaryState = { kind: "broken", path: resolved.path, message: `\`${resolved.path} --version\` failed: ${why}` };
    } else if (!isAtLeast(version, MIN_VERSION)) {
      this.binaryState = { kind: "tooOld", path: resolved.path, version };
    } else {
      this.binaryState = { kind: "ready", path: resolved.path, version, setting };
      this.log(`Using kv-cli ${version.text} at ${resolved.path}`);
    }
    this.changeEmitter.fire();
    if (this.binaryState.kind !== "ready") {
      void this.showBinaryProblem();
    } else if (!isAtLeast(version!, SQL_VERSION)) {
      const key = `kovallent.sqlNotice.${version!.text}`;
      if (!this.globalState.get<boolean>(key)) {
        await this.globalState.update(key, true);
        void this.ui.show({
          kind: "info",
          modal: false,
          text: `kv-cli ${version!.text} is older than 0.14.0, so dbt SQL models won't be checked. Python, notebooks and config files are checked as usual.`,
          buttons: [],
        });
      }
    }
  }

  /** The one notification for a missing, too old or broken kv-cli. */
  async showBinaryProblem(): Promise<void> {
    const b = this.binaryState;
    if (b.kind === "missing") {
      const where = b.setting.value ? `at "${b.setting.value}" (kovallent.path)` : "on PATH";
      const choice = await this.ui.show({
        kind: "warning",
        modal: false,
        text: `kv-cli was not found ${where}. The Kovallent extension runs your own kv-cli and never downloads one.`,
        buttons: [COPY_PIP_BUTTON, OPEN_INSTALL_BUTTON],
      });
      if (choice === COPY_PIP_BUTTON) {
        await vscode.env.clipboard.writeText(PIP_INSTALL);
      } else if (choice === OPEN_INSTALL_BUTTON) {
        await vscode.env.openExternal(vscode.Uri.parse(INSTALL_URL));
      }
    } else if (b.kind === "tooOld") {
      await this.ui.show({
        kind: "error",
        modal: false,
        text: `kv-cli ${b.version.text} is older than 0.9.0, the first release whose JSON payload lists every file (run.files). Upgrade kv-cli: the Kovallent extension will not run this one.`,
        buttons: [],
      });
    } else if (b.kind === "broken") {
      await this.ui.show({ kind: "error", modal: false, text: `kv-cli did not run. ${b.message}`, buttons: [] });
    }
  }

  /** Forget every result and find kv-cli again, e.g. after kovallent.path changed. */
  async redetect(): Promise<void> {
    this.pending.cancelAll();
    for (const r of this.inflight.values()) {
      r.run.cancel();
    }
    this.inflight.clear();
    this.diagnostics.clear();
    this.states.clear();
    await this.detect();
    this.auditOpenDocuments();
  }

  private async readyBinary(): Promise<Extract<BinaryState, { kind: "ready" }> | undefined> {
    await this.detection;
    const b = this.binaryState;
    return b.kind === "ready" ? b : undefined;
  }

  // ------------------------------------------------------------ per file

  auditOpenDocuments(): void {
    for (const doc of vscode.workspace.textDocuments) {
      this.schedule(doc.uri, 0);
    }
    for (const nb of vscode.workspace.notebookDocuments) {
      this.schedule(nb.uri, 0);
    }
  }

  /** Audit `uri` after `delayMs`, replacing any audit already waiting for it. */
  schedule(uri: vscode.Uri, delayMs: number): void {
    if (uri.scheme !== "file" || !classify(uri.fsPath)) {
      return;
    }
    this.pending.schedule(uri.toString(), delayMs, () => void this.auditFile(uri));
  }

  /** When the audit waiting for `uri` starts, on the debouncer's clock. For tests. */
  auditDue(uri: vscode.Uri): number | undefined {
    return this.pending.due(uri.toString());
  }

  async auditFile(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    this.busy++;
    let b;
    try {
      b = await this.readyBinary();
    } finally {
      this.busy--;
    }
    if (!b || !fs.existsSync(uri.fsPath)) {
      return;
    }
    const startedAt = Date.now();
    if (classify(uri.fsPath) === "sql" && !isAtLeast(b.version, SQL_VERSION)) {
      this.diagnostics.set(uri, []);
      this.setState(uri, { kind: "sqlUnsupported", version: b.version.text }, startedAt);
      return;
    }
    // A newer audit supersedes one still running for the same file.
    this.inflight.get(key)?.run.cancel();
    const target = this.target(uri);
    const args = ["audit", "--format", "json", ...this.configArgs(uri, target.cwd), "--", target.arg];
    const run = runKvCli(b.path, args, target.cwd, this.log);
    const token = { run, startedAt };
    this.inflight.set(key, token);
    if (!this.states.has(key)) {
      this.setState(uri, { kind: "auditing" }, startedAt);
    }
    const result = await run.result;
    if (this.inflight.get(key) !== token) {
      return;
    }
    this.inflight.delete(key);
    if (result.cancelled) {
      return;
    }
    const outcome = interpret(result);
    if (outcome.kind === "toolError") {
      this.applyToolError(uri, outcome.message, startedAt);
    } else {
      this.applyFileResult(uri, outcome.payload, startedAt);
    }
  }

  private applyToolError(uri: vscode.Uri, message: string, startedAt: number): void {
    // Clear what an earlier run left rather than show stale findings.
    this.diagnostics.set(uri, [couldNotAuditDiagnostic(message, this.reader(uri))]);
    this.setState(uri, { kind: "error", message }, startedAt);
    void this.notifyToolError(message);
  }

  private async notifyToolError(message: string): Promise<void> {
    const choice = await this.ui.showErrorOnce(`kv-cli: ${message}`, ["Show output"]);
    if (choice === "Show output") {
      this.output.show(true);
    }
  }

  /** A single-file run resolves that file only, so its payload is about that file. */
  private applyFileResult(uri: vscode.Uri, payload: Payload, startedAt: number): void {
    const files = payload.run.files;
    const target = this.target(uri);
    const base = payloadBase(payload, target.cwd, path.dirname(path.resolve(target.cwd, target.arg)));
    const entry =
      files.length === 1 ? files[0] : files.find((f) => samePath(resolvePayloadPath(f.path, base), uri.fsPath));
    if (!entry) {
      this.diagnostics.set(uri, []);
      this.setState(uri, { kind: "excluded" }, startedAt);
      return;
    }
    this.applyEntry(uri, entry, payload, startedAt);
  }

  private applyEntry(uri: vscode.Uri, entry: FileResult, payload: Payload, startedAt: number): void {
    const skipped = payload.run.skipped.find((s) => s.path === entry.path);
    if (classify(uri.fsPath) === "sql" && readAsPython(entry, skipped)) {
      this.diagnostics.set(uri, []);
      this.setState(uri, { kind: "notDbtModel" }, startedAt);
      return;
    }
    const read = this.reader(uri);
    const toolVersion = payload.run.tool_version;
    const diagnostics = payload.findings
      .filter((f) => f.path === entry.path)
      .map((f) => findingDiagnostic(f, read, toolVersion));
    if (skipped) {
      diagnostics.push(skippedDiagnostic(skipped, read));
    }
    this.diagnostics.set(uri, diagnostics);
    this.setState(uri, { kind: "result", entry, skipped, toolVersion }, startedAt);
  }

  private setState(uri: vscode.Uri, state: FileState, startedAt: number): void {
    this.states.set(uri.toString(), { state, startedAt });
    this.changeEmitter.fire();
  }

  forget(uri: vscode.Uri): void {
    const key = uri.toString();
    this.pending.cancel(key);
    this.inflight.get(key)?.run.cancel();
    this.inflight.delete(key);
    this.states.delete(key);
    this.diagnostics.delete(uri);
    this.changeEmitter.fire();
  }

  /** The text kv-cli read, to find each line's first and last non-whitespace character. */
  private reader(uri: vscode.Uri): LineReader {
    try {
      return linesOf(fs.readFileSync(uri.fsPath, "utf8"));
    } catch {
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      return doc ? linesOf(doc.getText()) : () => undefined;
    }
  }

  /** The workspace folder is the working directory, so kv-cli finds the nearest `.kovallent.yaml` itself. */
  private target(uri: vscode.Uri): Target {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder && folder.uri.scheme === "file") {
      const rel = path.relative(folder.uri.fsPath, uri.fsPath);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        return { cwd: folder.uri.fsPath, arg: rel };
      }
    }
    return { cwd: path.dirname(uri.fsPath), arg: path.basename(uri.fsPath) };
  }

  /** `--config` only when the user set kovallent.config. */
  private configArgs(resource: vscode.Uri | undefined, cwd: string): string[] {
    const value = vscode.workspace.getConfiguration("kovallent", resource).get<string>("config")?.trim();
    if (!value) {
      return [];
    }
    return ["--config", path.resolve(cwd, expand(value, cwd))];
  }

  // ------------------------------------------------------------ workspace

  async auditWorkspace(): Promise<void> {
    const b = await this.readyBinary();
    if (!b) {
      await this.showBinaryProblem();
      return;
    }
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file");
    if (folders.length === 0) {
      await this.ui.show({ kind: "info", modal: false, text: "Open a folder to audit a workspace with kv-cli.", buttons: [] });
      return;
    }
    this.busy++;
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "kv-cli: auditing workspace", cancellable: true },
        async (progress, cancel) => {
          for (const folder of folders) {
            if (cancel.isCancellationRequested) {
              return;
            }
            progress.report({ message: folder.name });
            const cwd = folder.uri.fsPath;
            const startedAt = Date.now();
            const args = ["audit", "--format", "json", ...this.configArgs(folder.uri, cwd), "--", "."];
            const run = runKvCli(b.path, args, cwd, this.log, 10 * 60_000);
            const sub = cancel.onCancellationRequested(() => run.cancel());
            const result = await run.result;
            sub.dispose();
            if (result.cancelled) {
              return;
            }
            const outcome = interpret(result);
            if (outcome.kind === "toolError") {
              void this.notifyToolError(outcome.message);
              continue;
            }
            this.applyWorkspaceResult(cwd, outcome.payload, startedAt);
            const run_ = outcome.payload.run;
            const verdict = outcome.exitCode === 0 ? "PASS" : "FAIL";
            vscode.window.setStatusBarMessage(
              `kv-cli ${verdict} in ${folder.name}: ${run_.errors} errors, ${run_.warnings} warnings, ` +
                `${run_.skipped.length} skipped, across ${run_.files_scanned} files`,
              10_000,
            );
          }
        },
      );
    } finally {
      this.busy--;
    }
    await vscode.commands.executeCommand("workbench.actions.view.problems");
  }

  private applyWorkspaceResult(cwd: string, payload: Payload, startedAt: number): void {
    const base = payloadBase(payload, cwd, cwd);
    for (const entry of payload.run.files) {
      const uri = vscode.Uri.file(resolvePayloadPath(entry.path, base));
      const key = uri.toString();
      // A file saved while the workspace ran already has a newer result.
      if ((this.states.get(key)?.startedAt ?? 0) > startedAt || (this.inflight.get(key)?.startedAt ?? 0) > startedAt) {
        continue;
      }
      this.applyEntry(uri, entry, payload, startedAt);
    }
  }

  // ------------------------------------------------------------------ fix

  /**
   * Save, run `kv-cli fix --dry-run`, show its output, and only after the user
   * confirms run `kv-cli fix`. kv-cli writes the file and VS Code reloads it
   * from disk: the extension never edits the buffer.
   */
  async fixFile(uri: vscode.Uri): Promise<void> {
    const b = await this.readyBinary();
    if (!b) {
      await this.showBinaryProblem();
      return;
    }
    const name = path.basename(uri.fsPath);
    if (!(await saveIfDirty(uri))) {
      await this.ui.show({ kind: "error", modal: false, text: `Save ${name} before applying kv-cli fix.`, buttons: [] });
      return;
    }
    const target = this.target(uri);
    const config = this.configArgs(uri, target.cwd);

    this.busy++;
    let dryRun: RunResult;
    try {
      dryRun = await runKvCli(b.path, ["fix", "--dry-run", ...config, "--", target.arg], target.cwd, this.log).result;
    } finally {
      this.busy--;
    }
    if (dryRun.exitCode !== 0) {
      void this.notifyToolError(toolErrorMessage(dryRun));
      return;
    }
    const dryOutput = stripAnsi(dryRun.stdout).trimEnd();
    const manual = manualLines(dryOutput);
    const previewUri = this.previews.put(`${name} - kv-cli fix --dry-run.txt`, dryOutput + "\n");
    await vscode.window.showTextDocument(previewUri, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: true,
      preserveFocus: true,
    });

    const detail = [
      "Nothing has been written yet: the dry run's output is open beside the editor.",
      "kv-cli writes the file itself, and VS Code reloads it from disk.",
      ...(manual.length > 0 ? ["", "kv-cli fix leaves these for a person:", ...manual] : []),
    ].join("\n");
    const choice = await this.ui.show({
      kind: "warning",
      modal: true,
      text: `Apply kv-cli fix to ${name}?`,
      detail,
      buttons: [APPLY_FIX_BUTTON],
    });
    await closeTab(previewUri);
    this.previews.delete(previewUri);
    if (choice !== APPLY_FIX_BUTTON) {
      this.log(`kv-cli fix cancelled for ${name}; nothing was written.`);
      return;
    }
    if (!(await saveIfDirty(uri))) {
      return;
    }

    const before = readBytes(uri.fsPath);
    this.busy++;
    let applied: RunResult;
    try {
      applied = await runKvCli(b.path, ["fix", ...config, "--", target.arg], target.cwd, this.log).result;
    } finally {
      this.busy--;
    }
    if (applied.exitCode !== 0) {
      void this.notifyToolError(toolErrorMessage(applied));
      return;
    }
    const output = stripAnsi(applied.stdout).trimEnd();
    this.output.appendLine(output);
    const changed = before !== undefined && !before.equals(readBytes(uri.fsPath) ?? Buffer.alloc(0));
    // kv-cli wrote the file outside the editor, which is not a save: audit it now.
    this.schedule(uri, 0);

    const left = manualLines(output);
    const summary = changed ? `kv-cli fix rewrote ${name}.` : `kv-cli fix made no changes to ${name}.`;
    const text =
      left.length > 0
        ? `${summary} It left ${left.length === 1 ? "this" : `these ${left.length}`} for a person:\n${left.join("\n")}`
        : summary;
    const buttons = changed ? ["Show diff", "Show output"] : ["Show output"];
    const pick = await this.ui.show({ kind: "info", modal: false, text, buttons });
    if (pick === "Show diff" && before) {
      const left_ = this.previews.put(`${name} (before kv-cli fix)`, before.toString("utf8"));
      await vscode.commands.executeCommand("vscode.diff", left_, uri, `${name}: before and after kv-cli fix`);
    } else if (pick === "Show output") {
      this.output.show(true);
    }
  }
}

// ------------------------------------------------------------------ helpers

function interpret(r: RunResult): Outcome {
  if (r.spawnError) {
    return { kind: "toolError", message: `could not be started: ${r.spawnError.message}` };
  }
  if (r.timedOut) {
    return { kind: "toolError", message: "did not finish in time and was stopped" };
  }
  switch (r.exitCode) {
    case 0: // compliant
    case 1: // findings: not an error
      try {
        return { kind: "payload", payload: parsePayload(r.stdout), exitCode: r.exitCode };
      } catch (e) {
        if (e instanceof PayloadError) {
          return { kind: "toolError", message: e.message };
        }
        throw e;
      }
    case 2: // tool error
    case 3: // contract drift: needs --expect-contract, which is never passed
    default:
      return { kind: "toolError", message: toolErrorMessage(r) };
  }
}

function toolErrorMessage(r: RunResult): string {
  const stderr = stripAnsi(r.stderr).trim();
  if (stderr) {
    return stderr;
  }
  if (r.spawnError) {
    return `could not be started: ${r.spawnError.message}`;
  }
  const meaning: Record<number, string> = { 2: " (tool error)", 3: " (contract drift)" };
  return r.exitCode === null
    ? `was stopped by ${r.signal ?? "a signal"}`
    : `exited with code ${r.exitCode}${meaning[r.exitCode] ?? ""}`;
}

/**
 * Payload paths are relative to the folder holding the contract kv-cli used
 * (`run.contract_path`, relative to the working directory) or, with no
 * contract, to the folder it was asked to scan.
 */
function payloadBase(payload: Payload, cwd: string, fallback: string): string {
  const contract = payload.run.contract_path;
  return contract ? path.dirname(path.resolve(cwd, contract)) : fallback;
}

function resolvePayloadPath(p: string, base: string): string {
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(base, p);
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const n = path.normalize(p);
    return process.platform === "win32" || process.platform === "darwin" ? n.toLowerCase() : n;
  };
  return norm(a) === norm(b);
}

/**
 * A dbt model reads `analysis: sql`, or `partial` with `sql_not_parsed`. A
 * `.sql` file that reads `full`, or `partial` with `syntax_error`, was not a
 * model: kv-cli read it as Python, so its result says nothing about the SQL.
 */
function readAsPython(entry: FileResult, skipped: SkippedFile | undefined): boolean {
  return entry.analysis === "full" || (entry.analysis === "partial" && skipped?.reason === "syntax_error");
}

/** `manual:` lines from `kv-cli fix`, as kv-cli printed them. */
export function manualLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("manual:"));
}

async function saveIfDirty(uri: vscode.Uri): Promise<boolean> {
  const key = uri.toString();
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
  if (doc?.isDirty) {
    return doc.save();
  }
  const nb = vscode.workspace.notebookDocuments.find((n) => n.uri.toString() === key);
  if (nb?.isDirty) {
    return nb.save();
  }
  return true;
}

function readBytes(file: string): Buffer | undefined {
  try {
    return fs.readFileSync(file);
  } catch {
    return undefined;
  }
}

async function closeTab(uri: vscode.Uri): Promise<void> {
  const tabs = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString());
  if (tabs.length > 0) {
    await vscode.window.tabGroups.close(tabs);
  }
}

/** Read-only in-memory documents: the dry-run preview and the pre-fix snapshot. */
export class PreviewDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly docs = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private counter = 0;

  put(title: string, content: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: `/${title}`, query: String(++this.counter) });
    this.docs.set(uri.toString(), content);
    return uri;
  }

  delete(uri: vscode.Uri): void {
    this.docs.delete(uri.toString());
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? "";
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
