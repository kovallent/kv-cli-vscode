import * as vscode from "vscode";
import type { Finding, SkippedFile } from "./payload";

export const SOURCE = "kv-cli";
export const COULD_NOT_AUDIT = "kv-cli could not audit this file";

/** Line text by zero-based index; undefined past the end of the file. */
export type LineReader = (index: number) => string | undefined;

export function linesOf(text: string): LineReader {
  const lines = text.split(/\r\n|\r|\n/);
  return (i) => lines[i];
}

/**
 * kv-cli reports a line, not a column, so a diagnostic covers the line from
 * its first to its last non-whitespace character. The line is read only to
 * find those two columns; nothing on it is shown.
 */
export function lineRange(lineNumber: number, read: LineReader): vscode.Range {
  const index = Math.max(0, lineNumber - 1);
  const text = read(index) ?? "";
  const first = text.search(/\S/);
  if (first < 0) {
    return new vscode.Range(index, 0, index, text.length);
  }
  return new vscode.Range(index, first, index, text.trimEnd().length);
}

export function ruleUrl(code: string, toolVersion: string): vscode.Uri | undefined {
  if (!/^KV\d{3}$/.test(code)) {
    return undefined;
  }
  return vscode.Uri.parse(`https://github.com/kovallent/kv-cli/blob/v${toolVersion}/docs/rules/${code}.md`);
}

/**
 * One diagnostic per finding. Severity, message and detail are shown as kv-cli
 * emitted them; KV002 details are already redacted and are not touched.
 */
export function findingDiagnostic(f: Finding, read: LineReader, toolVersion: string): vscode.Diagnostic {
  const message = f.detail ? `${f.message}\n${f.detail}` : f.message;
  const severity =
    f.severity === "error"
      ? vscode.DiagnosticSeverity.Error
      : vscode.DiagnosticSeverity.Warning;
  const d = new vscode.Diagnostic(lineRange(f.line, read), message, severity);
  d.source = SOURCE;
  const target = ruleUrl(f.code, toolVersion);
  d.code = target ? { value: f.code, target } : f.code;
  return d;
}

/** A file kv-cli did not fully analyse is never shown as clean. */
export function skippedDiagnostic(s: SkippedFile, read: LineReader): vscode.Diagnostic {
  const message = `kv-cli did not fully check this file: ${s.reason}` + (s.detail ? `\n${s.detail}` : "");
  const d = new vscode.Diagnostic(lineRange(1, read), message, vscode.DiagnosticSeverity.Information);
  d.source = SOURCE;
  d.code = s.reason;
  return d;
}

export function couldNotAuditDiagnostic(reason: string, read: LineReader): vscode.Diagnostic {
  const firstLine = reason.split(/\r?\n/).find((l) => l.trim() !== "")?.trim();
  const d = new vscode.Diagnostic(
    lineRange(1, read),
    firstLine ? `${COULD_NOT_AUDIT}\n${firstLine}` : COULD_NOT_AUDIT,
    vscode.DiagnosticSeverity.Error,
  );
  d.source = SOURCE;
  return d;
}

/** The KV codes that `kv-cli fix` can rewrite. KV003 and KV004 never are. */
export const FIXABLE_CODES = new Set(["KV001", "KV002"]);

export function diagnosticCode(d: vscode.Diagnostic): string | undefined {
  if (typeof d.code === "string" || typeof d.code === "number") {
    return String(d.code);
  }
  return d.code ? String(d.code.value) : undefined;
}
