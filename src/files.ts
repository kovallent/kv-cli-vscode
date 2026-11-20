import * as path from "path";

/**
 * The kinds of file kv-cli scans, recognised by name the way kv-cli itself
 * recognises them (its default `scan.include`, plus dbt `.sql` models from
 * 0.14.0). kv-cli treats any other file it is handed as Python, so the
 * extension never hands it one.
 */
export type FileClass = "python" | "notebook" | "config" | "sql";

export function classify(fsPath: string): FileClass | undefined {
  const name = path.basename(fsPath).toLowerCase();
  if (name === ".env" || name.startsWith(".env.") || name.endsWith(".env")) {
    return "config";
  }
  switch (path.extname(name)) {
    case ".py":
      return "python";
    case ".ipynb":
      return "notebook";
    case ".yml":
    case ".yaml":
    case ".toml":
    case ".ini":
    case ".cfg":
    case ".json":
      return "config";
    case ".sql":
      return "sql";
    default:
      return undefined;
  }
}
