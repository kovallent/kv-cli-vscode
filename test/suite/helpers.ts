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

export async function waitFor<T>(
  what: string,
  probe: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v !== undefined && v !== false) {
      return v;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(25);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function idle(a: TestApi): Promise<void> {
  // Twice, with a pause, so an audit scheduled by an event that is still on
  // its way counts too.
  await waitFor("the extension to go idle", () => a.controller.idle);
  await sleep(100);
  await waitFor("the extension to go idle", () => a.controller.idle);
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

export function setScenario(s: { version?: string; delayMs?: number; replay?: string }): void {
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
