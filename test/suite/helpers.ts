import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import Mocha from "mocha";
import * as vscode from "vscode";
import type { TestApi } from "../../src/extension";
import type { Payload } from "../../src/payload";

export const EXTENSION_ID = "kovallent.kv-cli-vscode";
export const root = path.resolve(__dirname, "..", "..", "..");
export const fixtures = path.join(root, "test", "fixtures", "recorded");

export function env(name: string): string {
  const v = process.env[name];
  assert.ok(v, `${name} is not set; run the tests with npm test`);
  return v;
}

export function wsPath(rel: string): string {
  return path.join(env("KV_TEST_WORKSPACE"), rel);
}

export function wsUri(rel: string): vscode.Uri {
  return vscode.Uri.file(wsPath(rel));
}

export async function api(): Promise<TestApi> {
  const ext = vscode.extensions.getExtension<TestApi | undefined>(EXTENSION_ID);
  assert.ok(ext, `extension ${EXTENSION_ID} is not installed`);
  const testApi = await ext.activate();
  assert.ok(testApi, "the extension returns its test API only under the test runner");
  return testApi;
}

/** How long any wait in these tests may take before it fails. */
export const WAIT_MS = 15_000;

/**
 * Wait until `probe` returns something other than undefined or false, and
 * return it. Tests never sleep for a fixed time: they wait on a condition,
 * and fail after `timeoutMs` saying what they waited for. `what` can be a
 * function, to describe the state at the moment of failure.
 */
export async function waitFor<T>(
  what: string | (() => string),
  probe: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = WAIT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v !== undefined && v !== false) {
      return v;
    }
    if (Date.now() > deadline) {
      const description = typeof what === "string" ? what : what();
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${description}`);
    }
    // The poll interval, not a wait for anything to happen.
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** No audit waiting, running or detecting kv-cli. */
export async function idle(a: TestApi): Promise<void> {
  await waitFor("the extension to go idle", () => a.controller.idle);
}

/** Wait until the status bar reads `expected`, showing what it read on failure. */
export async function statusReads(a: TestApi, expected: string | undefined): Promise<void> {
  await waitFor(
    () => `the status bar to read ${JSON.stringify(expected)}; it reads ${JSON.stringify(a.statusBar.text)}`,
    () => a.statusBar.text === expected,
  );
}

/**
 * Change a kovallent setting and return once the extension has reacted. The
 * extension's configuration listener was registered at activation, before
 * the one here, so when this one fires the extension has already scheduled
 * its audits or started finding kv-cli again; callers then wait for idle.
 * Setting a value it already has fires no event, so that returns at once.
 */
export async function setSetting(
  key: "path" | "config",
  value: string | undefined,
  target: vscode.ConfigurationTarget,
): Promise<void> {
  const config = vscode.workspace.getConfiguration("kovallent");
  const inspected = config.inspect<string>(key);
  const current =
    target === vscode.ConfigurationTarget.Global
      ? inspected?.globalValue
      : target === vscode.ConfigurationTarget.Workspace
        ? inspected?.workspaceValue
        : inspected?.workspaceFolderValue;
  if (current === value) {
    return;
  }
  let seen = false;
  const sub = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(`kovallent.${key}`)) {
      seen = true;
    }
  });
  try {
    await config.update(key, value, target);
    await waitFor(`the change to kovallent.${key} to reach the extension`, () => seen);
  } finally {
    sub.dispose();
  }
}

export async function show(rel: string): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument(wsUri(rel));
  return vscode.window.showTextDocument(doc);
}

/** Open a file and wait for its kv-cli result. */
export async function audited(a: TestApi, rel: string): Promise<vscode.TextEditor> {
  const editor = await show(rel);
  await waitFor(`a kv-cli result for ${rel}`, () => {
    const s = a.controller.stateOf(editor.document.uri);
    return s && s.kind !== "auditing";
  });
  await idle(a);
  return editor;
}

export function recordedPayload(name: string): Payload {
  return JSON.parse(fs.readFileSync(path.join(fixtures, `${name}.stdout`), "utf8"));
}

export function recordedText(name: string): string {
  return fs.readFileSync(path.join(fixtures, name), "utf8");
}

export interface Invocation {
  args: string[];
  cwd: string;
  event: "start" | "exit" | "killed";
  code?: number;
  targetSha: string | null;
  pid: number;
  time: number;
}

/** Every call the fake kv-cli received, in order. */
export function invocations(): Invocation[] {
  const file = env("KV_FAKE_LOG");
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

export function starts(): Invocation[] {
  return invocations().filter((i) => i.event === "start");
}

export function clearInvocations(): void {
  fs.rmSync(env("KV_FAKE_LOG"), { force: true });
}

/**
 * Change how the fake kv-cli answers. `holdUntil` makes every audit wait
 * until that file exists before it answers, so a test decides when a run
 * finishes instead of racing a delay.
 */
export function setScenario(s: { version?: string; holdUntil?: string; replay?: string }): void {
  fs.writeFileSync(env("KV_FAKE_SCENARIO"), JSON.stringify(s));
}

export function clearScenario(): void {
  fs.rmSync(env("KV_FAKE_SCENARIO"), { force: true });
}

/** Dismiss every notification still waiting, as if the user closed it. */
export function dismissAll(a: TestApi): void {
  for (const p of a.ui.recorded) {
    p.answer(undefined);
  }
  a.ui.recorded.length = 0;
  a.ui.responder = undefined;
}

export function runSuite(dir: string, files: string[]): Promise<void> {
  const mocha = new Mocha({ ui: "tdd", color: true, timeout: 60_000 });
  for (const f of files) {
    mocha.addFile(path.join(dir, `${f}.test.js`));
  }
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures > 0 ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
  });
}
