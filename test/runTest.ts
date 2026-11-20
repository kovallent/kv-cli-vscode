/**
 * Launches VS Code three times, once per suite, each on a fresh copy of
 * samples/ with a fresh profile:
 *
 *   main       the fake kv-cli on PATH, workspace trusted
 *   missing    no kv-cli anywhere on PATH
 *   untrusted  the fake kv-cli on PATH, workspace trust on and the folder not
 *              trusted, with a workspace-level kovallent.path pointing at a trap
 *
 * runTests() always passes --disable-workspace-trust, so VS Code is started
 * here directly, the same way for every suite.
 */
import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";

const root = path.resolve(__dirname, "..", "..");
const fakeDir = path.join(root, "test", "fake-kv-cli");

interface Suite {
  name: string;
  trusted: boolean;
  fakeOnPath: boolean;
  workspaceSettings?: Record<string, unknown>;
}

const suites: Suite[] = [
  { name: "main", trusted: true, fakeOnPath: true },
  { name: "missing", trusted: true, fakeOnPath: false },
  {
    name: "untrusted",
    trusted: false,
    fakeOnPath: true,
    workspaceSettings: { "kovallent.path": "./trap/kv-cli" },
  },
];

/** PATH with no directory that holds a kv-cli. */
function pathWithoutKvCli(): string {
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((dir) => dir && !fs.existsSync(path.join(dir, process.platform === "win32" ? "kv-cli.exe" : "kv-cli")))
    .join(path.delimiter);
}

/** Records that it ran, then behaves exactly like the fake. */
function writeTrap(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const trap = path.join(dir, "kv-cli");
  fs.writeFileSync(
    trap,
    `#!/usr/bin/env node
"use strict";
require("fs").appendFileSync(process.env.KV_TRAP_MARKER, process.argv.slice(2).join(" ") + "\\n");
const r = require("child_process").spawnSync(${JSON.stringify(path.join(fakeDir, "kv-cli"))}, process.argv.slice(2), { stdio: "inherit" });
process.exit(r.status ?? 1);
`,
  );
  fs.chmodSync(trap, 0o755);
}

function launch(executable: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(executable, args, { env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

async function main(): Promise<void> {
  const executable = await downloadAndUnzipVSCode(process.env.VSCODE_TEST_VERSION ?? "stable");
  const only = process.env.KV_TEST_SUITE;
  let failed = 0;
  for (const suite of suites.filter((s) => !only || s.name === only)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `kv-cli-vscode-${suite.name}-`));
    const workspace = path.join(tmp, "workspace");
    fs.cpSync(path.join(root, "samples"), workspace, { recursive: true });
    writeTrap(path.join(workspace, "trap"));
    if (suite.workspaceSettings) {
      fs.mkdirSync(path.join(workspace, ".vscode"));
      fs.writeFileSync(
        path.join(workspace, ".vscode", "settings.json"),
        JSON.stringify(suite.workspaceSettings, null, 2),
      );
    }
    const userData = path.join(tmp, "user-data");
    fs.mkdirSync(path.join(userData, "User"), { recursive: true });
    fs.writeFileSync(
      path.join(userData, "User", "settings.json"),
      JSON.stringify(
        {
          "workbench.startupEditor": "none",
          "telemetry.telemetryLevel": "off",
          "extensions.autoUpdate": false,
          "git.enabled": false,
          "security.workspace.trust.enabled": !suite.trusted,
          "security.workspace.trust.startupPrompt": "never",
          "security.workspace.trust.emptyWindow": false,
        },
        null,
        2,
      ),
    );

    const args = [
      workspace,
      "--no-sandbox",
      "--disable-gpu-sandbox",
      "--disable-updates",
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-extensions",
      `--user-data-dir=${userData}`,
      `--extensions-dir=${path.join(tmp, "extensions")}`,
      `--extensionDevelopmentPath=${root}`,
      `--extensionTestsPath=${path.join(root, "out", "test", "suite", suite.name)}`,
    ];
    if (suite.trusted) {
      args.push("--disable-workspace-trust");
    }
    const basePath = pathWithoutKvCli();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: suite.fakeOnPath ? `${fakeDir}${path.delimiter}${basePath}` : basePath,
      KV_TEST_WORKSPACE: workspace,
      KV_TEST_SAMPLES: path.join(root, "samples"),
      KV_FAKE_DIR: fakeDir,
      KV_FAKE_LOG: path.join(tmp, "kv-cli.log"),
      KV_FAKE_SCENARIO: path.join(tmp, "scenario.json"),
      KV_TRAP_MARKER: path.join(tmp, "trap-ran"),
    };
    delete env.ELECTRON_RUN_AS_NODE;

    console.log(`\n=== suite: ${suite.name} (${workspace})`);
    const code = await launch(executable, args, env);
    if (code !== 0) {
      console.error(`=== suite ${suite.name} failed (exit ${code})`);
      failed++;
    }
  }
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
