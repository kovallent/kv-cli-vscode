export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** As kv-cli printed it, e.g. `0.14.0`. */
  text: string;
}

/** The first release whose payload lists every file in `run.files`. */
export const MIN_VERSION = parseVersion("0.9.0")!;
/** The first release that reads dbt SQL models. */
export const SQL_VERSION = parseVersion("0.14.0")!;

/** Reads `kv-cli 0.14.0` (or a bare `0.14.0`) as printed by `--version`. */
export function parseVersion(output: string): Version | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?/.exec(output);
  if (!m) {
    return undefined;
  }
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), text: m[0] };
}

export function compareVersions(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function isAtLeast(v: Version, min: Version): boolean {
  return compareVersions(v, min) >= 0;
}
