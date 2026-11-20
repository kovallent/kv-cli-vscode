/**
 * kv-cli's `--format json` payload, schema version 1, as documented in
 * kv-cli's `schema/findings.v1.json` and `docs/json-payload.md`. This is the
 * only interface the extension reads for findings: it never parses kv-cli's
 * text output.
 */

export type Severity = "error" | "warning";
export type FileStatus = "fail" | "warn" | "clean" | "skipped";
export type FileAnalysis =
  | "full"
  | "credentials_only"
  | "credentials_and_infrastructure"
  | "sql"
  | "partial"
  | "none";
export type SkipReason = "syntax_error" | "sql_not_parsed" | "unreadable";

export interface Scope {
  functions_total: number;
  functions_in_scope: number;
  functions_report_only: number;
  functions_exempt_framework: number;
  functions_exempt_user: number;
  functions_out_of_scope: number;
}

export interface Finding {
  fingerprint: string;
  path: string;
  line: number;
  code: string;
  severity: Severity | string;
  symbol: string;
  subject: string;
  message: string;
  detail?: string | null;
  framework?: string | null;
  report_only?: boolean | null;
  kind?: string;
}

export interface SkippedFile {
  path: string;
  reason: SkipReason | string;
  severity: Severity | string;
  detail?: string | null;
}

export interface FileResult {
  path: string;
  status: FileStatus;
  errors: number;
  warnings: number;
  analysis: FileAnalysis;
  scope: Scope;
}

export interface RunMeta {
  schema_version: number;
  tool_version: string;
  contract_path?: string | null;
  files_scanned: number;
  errors: number;
  warnings: number;
  skipped: SkippedFile[];
  files: FileResult[];
  scope: Scope;
  strict: boolean;
}

export interface Payload {
  run: RunMeta;
  findings: Finding[];
}

export const SCHEMA_VERSION = 1;

export class PayloadError extends Error {}

/**
 * Parse and check stdout from `kv-cli audit --format json`. Throws a
 * PayloadError when it is not a schema-version-1 payload with `run.files`.
 */
export function parsePayload(stdout: string): Payload {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new PayloadError("printed no JSON payload");
  }
  if (!isObject(data) || !isObject(data.run) || !Array.isArray(data.findings)) {
    throw new PayloadError("printed a payload with no `run` and `findings`");
  }
  const run = data.run;
  if (run.schema_version !== SCHEMA_VERSION) {
    throw new PayloadError(
      `printed a payload with schema_version ${String(run.schema_version)}; this extension reads version ${SCHEMA_VERSION}`,
    );
  }
  if (!Array.isArray(run.files)) {
    throw new PayloadError("printed a payload with no `run.files` (that needs kv-cli 0.9.0 or later)");
  }
  if (!Array.isArray(run.skipped)) {
    throw new PayloadError("printed a payload with no `run.skipped`");
  }
  for (const f of data.findings) {
    if (!isObject(f) || typeof f.path !== "string" || typeof f.line !== "number" || typeof f.message !== "string") {
      throw new PayloadError("printed a payload with a malformed finding");
    }
  }
  for (const f of run.files) {
    if (!isObject(f) || typeof f.path !== "string" || typeof f.status !== "string" || !isObject(f.scope)) {
      throw new PayloadError("printed a payload with a malformed `run.files` entry");
    }
  }
  return data as unknown as Payload;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** In scope and not report-only: what kv-cli calls "enforced". */
export function enforcedCount(scope: Scope): number {
  return scope.functions_in_scope - scope.functions_report_only;
}
