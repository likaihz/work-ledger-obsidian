# Local real-Obsidian verification

Use this workflow for UI and integration changes that must be verified in the real
Obsidian desktop runtime. It uses a repository-local synthetic Vault and the real
Work Ledger CLI source. Never point these commands at a personal Vault.

## One-time setup

Requirements:

- Obsidian desktop with the official `obsidian` CLI available (locally validated
  with Obsidian 1.13.7);
- Python 3.11 or newer with `tomllib` and Git on `PATH`;
- permission for the CLI to reach Obsidian's local IPC while the app is running.

Set `PYTHON=/absolute/path/to/python3` during setup when the desired interpreter is
not the first `python3` on `PATH`. The generated GUI-safe wrapper records the
interpreter's absolute path instead of relying on Obsidian's launch environment.

From `packages/work-ledger-obsidian`:

```text
npm ci
npm run local:setup
npm run package
npm run local:install-package
```

Register the printed `.e2e/Agent Ledger Dev` directory in Obsidian once, trust the
repository-built plugin, then keep that Vault open while running verification.
Rebuild the fixture only when its data contract changes. Close the synthetic Vault
before resetting it:

```text
npm run local:setup -- --reset
```

The reset command only removes the package-owned `.e2e` directory after checking
its exact path.

## Development cycle

After a plugin change:

```text
npm run verify
npm run local:install-package
npm run local:verify -- knowledge
```

The verification command serially clears Obsidian diagnostics, enables and reloads
the packaged plugin, opens the Knowledge route, waits for the real CLI handshake,
and checks the live Electron DOM. It rejects fixed-height or overflowing cards,
host button chrome, missing Inspector content, an incorrect archived filter result,
runtime errors, console errors, and any change below `Work/`. Console capture is
attached only for the verification run and is detached afterward, including when
an assertion fails. A debugger cleanup failure also fails the command.

Evidence is written under `.e2e/captures/`:

```text
knowledge-default.png
knowledge-selected.png
knowledge-layout.json
```

## Manual responsive pass

After the automated command passes, inspect the same synthetic data at:

- 1359 × 768 in light and dark themes;
- 960 × 640 with the Inspector closed and open;
- 700 × 640 with one-column filters and cards.

Exercise archived, kind, Project, and tag filters; select a card; double-click a
card; and use the explicit “在 Obsidian 打开” action. Attach console capture before
the manual interactions:

```text
obsidian vault="Agent Ledger Dev" dev:debug on
obsidian vault="Agent Ledger Dev" dev:errors clear
obsidian vault="Agent Ledger Dev" dev:console clear
```

Finish with:

```text
obsidian vault="Agent Ledger Dev" dev:errors
obsidian vault="Agent Ledger Dev" dev:console level=error
git -C ".e2e/Agent Ledger Dev" status --short -- Work
obsidian vault="Agent Ledger Dev" dev:debug off
```

All three commands must report no findings.
