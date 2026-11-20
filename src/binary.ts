import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

/** Where the `kovallent.path` value in use came from. */
export type PathSource = "user" | "workspace" | "workspaceFolder" | "none";

export interface PathSetting {
  /** The value in effect, or undefined to use `kv-cli` on PATH. */
  value: string | undefined;
  source: PathSource;
  /** A workspace-level value set but ignored because the workspace is untrusted. */
  ignoredWorkspaceValue?: string;
}

/**
 * Read `kovallent.path`. In an untrusted workspace only the user-level value
 * counts: a cloned repository's `.vscode/settings.json` could point it at
 * anything. (The manifest also lists it under `restrictedConfigurations`, so
 * VS Code does the same; this does not rely on that.)
 */
export function readPathSetting(trusted: boolean): PathSetting {
  const inspected = vscode.workspace.getConfiguration("kovallent").inspect<string>("path");
  const nonEmpty = (v: string | undefined) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
  const user = nonEmpty(inspected?.globalValue);
  const workspace = nonEmpty(inspected?.workspaceValue);
  const folder = nonEmpty(inspected?.workspaceFolderValue);
  if (!trusted) {
    return {
      value: user,
      source: user ? "user" : "none",
      ignoredWorkspaceValue: folder ?? workspace,
    };
  }
  if (folder) {
    return { value: folder, source: "workspaceFolder" };
  }
  if (workspace) {
    return { value: workspace, source: "workspace" };
  }
  return { value: user, source: user ? "user" : "none" };
}

export type Resolution =
  | { found: true; path: string }
  | { found: false; looked: string };

/**
 * Turn the setting into an executable path: `kv-cli` on PATH when unset, a
 * bare name on PATH, otherwise a file path (`~` and `${workspaceFolder}`
 * expanded, relative to the first workspace folder).
 */
export function resolveBinary(value: string | undefined, env: NodeJS.ProcessEnv = process.env): Resolution {
  if (!value) {
    const found = which("kv-cli", env);
    return found ? { found: true, path: found } : { found: false, looked: "kv-cli on PATH" };
  }
  const expanded = expand(value);
  if (!expanded.includes("/") && !expanded.includes("\\")) {
    const found = which(expanded, env);
    return found ? { found: true, path: found } : { found: false, looked: `${expanded} on PATH` };
  }
  let candidate = expanded;
  if (!path.isAbsolute(candidate)) {
    const base = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!base) {
      return { found: false, looked: value };
    }
    candidate = path.resolve(base, candidate);
  }
  return isExecutable(candidate) ? { found: true, path: candidate } : { found: false, looked: candidate };
}

export function expand(value: string, folder?: string): string {
  const base = folder ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  let out = value.replace(/\$\{workspaceFolder\}/g, base).replace(/\$\{userHome\}/g, os.homedir());
  if (out === "~" || out.startsWith("~/") || out.startsWith("~\\")) {
    out = path.join(os.homedir(), out.slice(1));
  }
  return out;
}

/** Find an executable on PATH, as a shell would. */
export function which(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const pathVar = env.PATH ?? env.Path ?? "";
  // Node spawns .exe and .com directly on Windows; .cmd/.bat would need a shell.
  const exts = process.platform === "win32" ? [".exe", ".com", ""] : [""];
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const ext of exts) {
      const candidate = path.join(dir, name.toLowerCase().endsWith(ext) ? name : name + ext);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function isExecutable(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) {
      return false;
    }
    if (process.platform !== "win32") {
      fs.accessSync(file, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}
