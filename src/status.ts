import { enforcedCount, type FileResult, type SkippedFile } from "./payload";

/** What the extension last learned about one file. */
export type FileState =
  | { kind: "auditing" }
  | { kind: "result"; entry: FileResult; skipped?: SkippedFile; toolVersion: string }
  /** kv-cli exited 0 or 1 but listed no entry: the contract's scan.exclude covers the file. */
  | { kind: "excluded" }
  /** A `.sql` file kv-cli read as Python because it is not a dbt model. */
  | { kind: "notDbtModel" }
  /** A `.sql` file, with a kv-cli older than 0.14.0. */
  | { kind: "sqlUnsupported"; version: string }
  | { kind: "error"; message: string };

export interface StatusView {
  text: string;
  tooltip: string;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * The status bar wording for one file. It describes that file's own
 * `run.files` entry and never says "compliant": that word belongs to the
 * run-level PASS verdict.
 */
export function statusView(state: FileState): StatusView {
  switch (state.kind) {
    case "auditing":
      return { text: "$(sync~spin) kv-cli", tooltip: "kv-cli is auditing this file" };
    case "excluded":
      return {
        text: "kv-cli: excluded by contract",
        tooltip: "kv-cli listed no result for this file: the contract's scan.exclude covers it.",
      };
    case "notDbtModel":
      return {
        text: "kv-cli: not a dbt model",
        tooltip:
          "kv-cli checks a .sql file only when it is a dbt model: under the model or snapshot paths of the nearest dbt_project.yml.",
      };
    case "sqlUnsupported":
      return {
        text: "kv-cli: SQL not checked",
        tooltip: `kv-cli ${state.version} does not read dbt SQL models; 0.14.0 is the first release that does.`,
      };
    case "error":
      return { text: "$(error) kv-cli: could not audit", tooltip: state.message };
    case "result":
      return resultView(state.entry, state.skipped, state.toolVersion);
  }
}

function resultView(entry: FileResult, skipped: SkippedFile | undefined, toolVersion: string): StatusView {
  const footer = `\n\nkv-cli ${toolVersion}. Click to open the Problems panel.`;
  const enforced = enforcedCount(entry.scope);
  switch (entry.status) {
    case "clean": {
      const note = "\nThis is this file's own result, not the run-level verdict.";
      switch (entry.analysis) {
        case "credentials_only":
          return {
            text: "kv-cli: credentials only",
            tooltip: `No findings. kv-cli scans this kind of file for credentials only (KV002).${note}${footer}`,
          };
        case "credentials_and_infrastructure":
          return {
            text: "kv-cli: clean (credentials and infrastructure)",
            tooltip: `No findings. A Databricks asset bundle file: checked for credentials and pinned infrastructure.${note}${footer}`,
          };
        case "sql":
          return {
            text: "kv-cli: clean (SQL model)",
            tooltip: `No findings. A dbt SQL model, parsed in full and checked for pinned infrastructure (KV003).${note}${footer}`,
          };
        default:
          if (enforced > 0) {
            return {
              text: `kv-cli: clean (${enforced} enforced)`,
              tooltip: `No findings. ${scopeLine(entry)}${note}${footer}`,
            };
          }
          return {
            text: "kv-cli: nothing enforced",
            tooltip: `No findings, but no function in this file is under the contract, so nothing was enforced. ${scopeLine(entry)}${footer}`,
          };
      }
    }
    case "skipped": {
      const reason = skipped?.reason ?? (entry.analysis === "none" ? "unreadable" : "not fully analysed");
      return {
        text: `$(warning) kv-cli: skipped (${reason})`,
        tooltip: `kv-cli did not fully check this file: ${reason}.${skipped?.detail ? `\n${skipped.detail}` : ""}${footer}`,
      };
    }
    default: {
      const parts: string[] = [];
      if (entry.errors > 0) {
        parts.push(plural(entry.errors, "error"));
      }
      if (entry.warnings > 0) {
        parts.push(plural(entry.warnings, "warning"));
      }
      const partial = skipped ? `\nOnly partly analysed (${skipped.reason}), so more may be hidden.` : "";
      return {
        text: `kv-cli: ${parts.join(", ")}`,
        tooltip: `Severity as kv-cli emits it; --strict is not applied.${partial}${footer}`,
      };
    }
  }
}

function scopeLine(entry: FileResult): string {
  const s = entry.scope;
  return (
    `Functions: ${s.functions_in_scope} in scope (${s.functions_report_only} report-only), ` +
    `${s.functions_exempt_framework} framework-exempt, ${s.functions_exempt_user} user-exempt, ` +
    `${s.functions_out_of_scope} out of scope.`
  );
}
