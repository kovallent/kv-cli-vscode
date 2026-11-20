import { runSuite } from "../helpers";

export function run(): Promise<void> {
  // In this order: fix rewrites deploy.py, and version swaps the binary.
  return runSuite(__dirname, ["diagnostics", "status", "toolError", "fix", "version"]);
}
