# Kovallent kv-cli for VS Code

Shows [kv-cli](https://github.com/kovallent/kv-cli) findings as editor
diagnostics: missing contract parameters (KV001), hardcoded credentials
(KV002), pinned infrastructure (KV003) and naming rules (KV004), in Python,
notebooks, config files and dbt SQL models.

**It needs kv-cli installed and never downloads it.** The extension runs the
kv-cli on your `PATH` (or in `kovallent.path`), so the editor and your
pre-commit hook run the same kv-cli. It needs **kv-cli 0.9.0 or later**, and
**0.14.0 or later** to check dbt SQL models.

**No network, no telemetry.** The extension makes no network calls and
collects nothing. kv-cli itself makes no network calls either. The only
links it opens are the ones you click: a rule's documentation on GitHub, or
kv-cli's install guide.

> **Screenshot placeholder:** diagnostics in `samples/deploy.py`, the status
> bar item and the `kv-cli fix` preview.

## Install kv-cli first

```bash
pip install kv-cli
```

`uv tool install kv-cli` and `brew install kovallent/tap/kv-cli` work too. See
[kv-cli's install guide](https://github.com/kovallent/kv-cli#quickstart). If
the extension can't find kv-cli, it says so once, with a button that copies
`pip install kv-cli` and one that opens the install guide, and runs nothing.

## What it shows

- **One diagnostic per finding**, read from `kv-cli audit --format json`, the
  only interface the extension reads. kv-cli reports a line, not a column, so
  each diagnostic covers its line from the first to the last non-whitespace
  character. `error` is an Error and `warning` a Warning, as kv-cli emits
  them: the extension never applies `--strict`. The message is the finding's
  `message`, with its `detail` on a second line. The code (KV001 to KV004)
  links to the rule's page at your kv-cli version. KV002 details arrive
  redacted from kv-cli and are shown as they are.
- **Files kv-cli could not fully check.** A file in the payload's
  `run.skipped` gets an Information diagnostic at line 1 giving the reason
  (`syntax_error`, `sql_not_parsed` or `unreadable`). It is never shown as
  clean.
- **A status bar item for the active file**, from that file's `run.files`
  entry. Click it to open the Problems panel.

  | Wording | When |
  | --- | --- |
  | `kv-cli: 2 errors, 1 warning` | The file has findings |
  | `kv-cli: clean (2 enforced)` | No findings; 2 functions were under the contract |
  | `kv-cli: nothing enforced` | No findings, but no function in it is under the contract |
  | `kv-cli: credentials only` | No findings in a YAML, `.env*`, TOML, INI/cfg, JSON file or notebook, which kv-cli checks for credentials only |
  | `kv-cli: clean (SQL model)` | No findings in a dbt SQL model |
  | `kv-cli: skipped (syntax_error)` | kv-cli did not fully check it |
  | `kv-cli: could not audit` | kv-cli failed (exit 2 or 3) |

  It never says "compliant" about a single file: that word belongs to kv-cli's
  run-level `PASS`.

## When it runs

- **On open and on save, never on a keystroke**, for the files kv-cli scans:
  Python, YAML, `.env*`, TOML, INI/cfg, JSON, notebooks and `.sql`. Saves are
  debounced to 300 ms per file, and a run that a newer one supersedes is
  cancelled.
- Each run is `kv-cli audit --format json -- <file>`, with the workspace folder
  as the working directory, so kv-cli finds the nearest `.kovallent.yaml`
  itself. `--config` is passed only if you set `kovallent.config`.
- A `.sql` file is checked only when it is a dbt model, under the model or
  snapshot paths of the nearest `dbt_project.yml`. Any other `.sql` file shows
  `kv-cli: not a dbt model`.
- **Kovallent: Audit workspace** (Command Palette) runs kv-cli once over each
  workspace folder and fills the Problems panel. It never runs on its own.

kv-cli's exit codes are handled one by one:

| Exit | Meaning | What the extension does |
| --- | --- | --- |
| 0 | Compliant | Shows the payload |
| 1 | Findings | Shows the payload. This is not an error |
| 2 | Tool error | Shows kv-cli's message in one error notification, clears the file's diagnostics and adds one at line 1: *kv-cli could not audit this file* |
| 3 | Contract drift | Only possible with `--expect-contract`, which the extension never passes. Treated as a tool error |

## Applying fixes

On a KV001 or KV002 diagnostic, the quick fix **Apply kv-cli fix to this file**:

1. saves the file if it has unsaved changes;
2. runs `kv-cli fix --dry-run -- <file>` and opens its output beside the editor;
3. asks you to confirm, listing each `manual:` line that `fix` leaves for a
   person, exactly as kv-cli printed it;
4. only then runs `kv-cli fix -- <file>`. kv-cli writes the file (and its
   `.kvbak` backup), and VS Code reloads it from disk. The extension never
   edits the buffer itself.

Cancelling at step 3 writes nothing. After a fix, **Show diff** compares the
file before and after. KV003 and KV004 never get a fix action, because
`kv-cli fix` never rewrites them.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `kovallent.path` | empty | Path to the `kv-cli` executable. Empty means `kv-cli` on `PATH`. A relative path resolves against the first workspace folder; `~` and `${workspaceFolder}` are expanded. |
| `kovallent.config` | empty | Contract file passed as `--config`. Empty passes nothing, so kv-cli finds the nearest `.kovallent.yaml`. |

The Kovallent output channel logs every kv-cli command line the extension
runs, with its exit code.

## Workspace trust

In an untrusted workspace (Restricted Mode), the extension has limited
support: a workspace-level `kovallent.path` is ignored, because a cloned
repository could point it at any program. The user-level `kovallent.path`, or
kv-cli on `PATH`, still runs, since kv-cli only reads files.

## Development

```bash
npm ci
npm test            # on Linux without a display: xvfb-run -a npm test
```

`npm test` builds the extension with esbuild and runs it in VS Code with
`@vscode/test-electron`, three times: with a fake `kv-cli` on `PATH`, with no
kv-cli at all, and in an untrusted workspace. The fake
(`test/fake-kv-cli/kv-cli`) replays payloads recorded from real kv-cli 0.14.0
runs on [`samples/`](samples/README.md), committed under
`test/fixtures/recorded/`. To record them again:

```bash
KV_CLI=/path/to/kv-cli-0.14.0 npm run record-fixtures
```

## Releasing

1. Set `version` in `package.json` and add the release to `CHANGELOG.md`.
2. Push the tag `v<version>`, for example `v0.1.0`. The release workflow fails
   unless the tag is `v` followed by `package.json`'s `version`. It tests the
   extension and packages the `.vsix` once. It uploads that file as a workflow
   artifact and as an asset on the tag's GitHub Release (creating the release
   if needed), then publishes the same file to Open VSX (which Cursor uses). It
   needs one repository secret, `OVSX_PAT`.
3. Publish to the VS Code Marketplace by hand. The workflow doesn't publish
   there for now: Azure DevOps global personal access tokens retire on
   2027-01-27, and Entra ID publishing comes later.
   1. Download `kv-cli-vscode-v<version>.vsix` from the tag's GitHub Release.
      It is the same file Open VSX received; don't package a new one.
   2. Upload it at <https://marketplace.visualstudio.com/manage>, under the
      `kovallent` publisher. The first release is a new extension; every
      release after that is an update to it.

## License

[MIT](LICENSE)
