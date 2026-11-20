# Changelog

This extension is versioned on its own, independent of kv-cli. It needs
kv-cli **0.9.0 or later** installed; with kv-cli older than 0.14.0, dbt SQL
models are not checked.

## [0.1.0]

First release.

- kv-cli findings as diagnostics, one per finding, read from
  `kv-cli audit --format json` only. Runs on open and on save (debounced to
  300 ms per file), never on a keystroke.
- Skipped files (`syntax_error`, `sql_not_parsed`, `unreadable`) get an
  Information diagnostic at line 1 and are never shown as clean.
- Exit codes handled one by one: 0 and 1 show the payload; 2 and 3 are tool
  errors that clear the file's diagnostics.
- Status bar item for the active file, from its `run.files` entry.
- **Kovallent: Audit workspace** command.
- **Apply kv-cli fix to this file** code action on KV001 and KV002: saves the
  file, previews `kv-cli fix --dry-run`, and runs `kv-cli fix` only after you
  confirm.
- Uses the kv-cli on `PATH` or in `kovallent.path`; never downloads one.
  Limited support in untrusted workspaces: a workspace-level `kovallent.path`
  is ignored.
