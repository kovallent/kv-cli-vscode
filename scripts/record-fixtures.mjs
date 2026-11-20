#!/usr/bin/env node
// Records the payloads the tests replay, from a real kv-cli 0.14.0 run on
// samples/. Run it whenever samples/ changes:
//
//   pip install kv-cli==0.14.0     # into a virtualenv of your choice
//   KV_CLI=/path/to/kv-cli npm run record-fixtures
//
// Each case runs exactly as the extension would: the workspace folder (a
// scratch copy of samples/) is the working directory and the file is passed
// after `--`. The copy keeps `kv-cli fix` from touching the committed samples.

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_VERSION = "0.14.0";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "test", "fixtures", "recorded");
const kv = process.env.KV_CLI || "kv-cli";

// name, args, optional setup. Paths are relative to the samples root, as the
// extension passes them.
const cases = [
  ["fail", ["audit", "--format", "json", "--", "deploy.py"]],
  ["pass", ["audit", "--format", "json", "--", "compliant.py"]],
  ["nothing-enforced", ["audit", "--format", "json", "--", "dbt_model.py"]],
  ["warnings", ["audit", "--format", "json", "--", "orders_job.py"]],
  ["syntax-error", ["audit", "--format", "json", "--", "broken.py"]],
  ["sql-not-parsed", ["audit", "--format", "json", "--", "dbt/models/unparsed.sql"]],
  ["sql-model", ["audit", "--format", "json", "--", "dbt/models/session.sql"]],
  ["credentials-only-yaml", ["audit", "--format", "json", "--", "config/pipeline.yml"]],
  ["workspace", ["audit", "--format", "json", "--", "."]],
  // The tests change workspace settings, and the extension audits the
  // settings file like any JSON file it opens.
  [
    "vscode-settings",
    ["audit", "--format", "json", "--", ".vscode/settings.json"],
    (ws) => {
      mkdirSync(join(ws, ".vscode"), { recursive: true });
      writeFileSync(join(ws, ".vscode", "settings.json"), '{\n  "kovallent.config": "missing.yaml"\n}\n');
    },
  ],
  // A real exit 2: the contract named by --config does not exist.
  ["tool-error", ["audit", "--format", "json", "--config", "missing.yaml", "--", "deploy.py"]],
  // A real exit 3, which needs --expect-contract (the extension never passes it).
  ["contract-drift", ["audit", "--format", "json", "--expect-contract", "0000000000000000", "--", "deploy.py"]],
  ["fix-dry-run", ["fix", "--dry-run", "--", "deploy.py"]],
  // Last: it rewrites deploy.py in the scratch copy.
  ["fix", ["fix", "--", "deploy.py"]],
];

const env = { ...process.env, NO_COLOR: "1" };
delete env.CLICOLOR_FORCE;

const version = spawnSync(kv, ["--version"], { encoding: "utf8", env });
if (version.error || version.status !== 0) {
  console.error(`cannot run ${kv} --version: ${version.error?.message ?? version.stderr}`);
  process.exit(1);
}
const versionLine = version.stdout.trim();
if (versionLine !== `kv-cli ${EXPECTED_VERSION}`) {
  console.error(`expected kv-cli ${EXPECTED_VERSION}, got "${versionLine}"`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "kv-cli-vscode-record-"));
const workspace = join(work, "samples");
cpSync(join(root, "samples"), workspace, { recursive: true });

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const manifest = { recordedWith: versionLine, cases: [] };
for (const [name, args, setup] of cases) {
  setup?.(workspace);
  const r = spawnSync(kv, args, { cwd: workspace, encoding: "utf8", env });
  if (r.error) {
    console.error(`${name}: ${r.error.message}`);
    process.exit(1);
  }
  writeFileSync(join(out, `${name}.stdout`), r.stdout);
  const entry = { name, args, exitCode: r.status, stdout: `${name}.stdout`, stderr: r.stderr };
  if (name === "fix") {
    writeFileSync(join(out, "deploy.fixed.py"), readFileSync(join(workspace, "deploy.py")));
    entry.writes = { "deploy.py": "deploy.fixed.py" };
  }
  manifest.cases.push(entry);
  console.log(`${name.padEnd(22)} exit ${r.status}  kv-cli ${args.join(" ")}`);
}
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
rmSync(work, { recursive: true, force: true });
console.log(`wrote ${manifest.cases.length} recordings to ${out}`);
