# Agent Ledger for Obsidian

Agent Ledger is a desktop-only, read-only Obsidian view for the independently distributed `work-ledger` CLI and its Work Ledger data. It visualizes projects, inherited task hierarchy, effective work events, weekly reports, health findings, native links, and backlinks without becoming a second writer for managed Markdown.

## Requirements

- Obsidian `1.12.0` or newer on desktop.
- Node.js `20` or newer for development and packaging.
- An absolute path to the `work-ledger` executable for the
  `work-ledger-cli >=0.8.0,<1.0.0` product.
- CLI protocol 1 with `snapshot`, `report.export`, `read_only_snapshot`, `clean_report_export`, and `inherited_child_projects`.
- A schema 4 Work Ledger Vault open as the current Obsidian Vault.
- For contract tests in a standalone community clone, either install the
  `work-ledger` console script from the `agent-ledger-harness` distribution on
  `PATH`, or set
  `WORK_LEDGER_TEST_EXECUTABLE` to its absolute, nonempty executable path.

The plugin rejects a configured CLI Vault whose SHA-256 identity does not match the open Obsidian Vault. It clears business state before displaying the mismatch, so content from another Vault is not shown.

## Pages

- Overview: focus tasks, recent effective events, and status counts.
- Projects: readable Project cards, root Tasks, and parent-only child hierarchy.
- Timeline: date-grouped effective Journal events and Journal marker navigation.
- Reports: report history, due status, evidence facts, Markdown navigation, and clean Markdown/plain-text copy actions.
- Health: CLI, protocol, schema, Vault, digest, Git HEAD, and doctor findings.

There is no dedicated Graph page in the first release. Obsidian's native Graph can still use the managed wikilinks.

## Build and package

Use Node.js 24. Node 20–24 are supported; Node 25 is excluded because its
macOS worker runtime can crash while Vitest starts.

In the monorepo, contract tests automatically use the sibling
`work-ledger-cli` source tree. A standalone community clone has no sibling CLI
source, so install the `agent-ledger-harness` distribution to provide
`work-ledger` on `PATH`, or set
`WORK_LEDGER_TEST_EXECUTABLE` before running verification.

```text
npm install
npm run verify
```

The verified install directory is:

```text
dist/agent-ledger/
├── main.js
├── manifest.json
├── styles.css
└── SHA256SUMS
```

Copy `main.js`, `manifest.json`, and `styles.css` into:

```text
<development-vault>/.obsidian/plugins/agent-ledger/
```

Reload Obsidian, enable Agent Ledger, and configure the absolute CLI path. Always use a separate synthetic development Vault while developing or testing the plugin.

The CLI entry must also work without interactive shell initialization. Prefer
an isolated-environment console script with an absolute Python shebang. A
zipapp using `/usr/bin/env python3` is only suitable when that desktop
environment resolves Python 3.11 or newer.

## Read-only boundary

The CLI client exposes only `version`, `capabilities`, `snapshot`, `project show`, `task show`, `event show`, `report due`, `report facts`, `report export`, `doctor`, and `migrate plan`.

The plugin does not expose or invoke:

- `apply`
- `report write`
- `migrate apply`
- `sync`
- Git commands
- direct writes to Project, Task, Journal, or Report Markdown

Settings contain only runtime and UI preferences. Project, Task, Event, Report, CLI stdout, and Agent context are kept in memory and are not persisted through `Plugin.saveData()`.
