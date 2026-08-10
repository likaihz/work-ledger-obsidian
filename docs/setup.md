# Setup and troubleshooting

Agent Ledger is a desktop-only Obsidian client for an existing Work Ledger
Vault. It does not install the CLI, create a real Vault, or apply migrations.

## Before you begin

You need:

- Obsidian desktop `1.12.0` or newer;
- Python 3.11 or newer, Git, and a supported `work-ledger >=0.8,<1.0` executable;
- CLI protocol 1 with `snapshot`, `report.export`, `read_only_snapshot`,
  `clean_report_export`, and inherited child-project support;
- a schema 4 Work Ledger Vault; and
- the absolute paths to the CLI executable and, when needed, its configuration.

## Install and verify Work Ledger

Production releases use the `agent-ledger-harness` distribution name and
provide the `work-ledger` command. Install an exact compatible release with a
user-level tool manager:

```text
pipx install agent-ledger-harness==<version>
uv tool install agent-ledger-harness==<version>
```

Use an exact production version rather than an unfixed latest release, an
editable checkout, or TestPyPI. Verify the selected executable before adding it
to Obsidian:

```text
/absolute/path/to/work-ledger --version
/absolute/path/to/work-ledger version
/absolute/path/to/work-ledger capabilities
```

The complete CLI installation and artifact-verification guidance is in the
[Work Ledger CLI README](https://github.com/likaihz/tz-agent-harness/blob/main/packages/work-ledger-cli/README.md).

## Prepare the Vault

The CLI configuration must resolve to the same absolute Vault that you open in
Obsidian. The Vault must use schema 4 and pass the CLI's diagnostic checks.

If an existing Vault uses schema 1, 2, or 3, generate a migration plan with the
CLI and review its paths, conflicts, and digest before applying it through the
controlled CLI workflow. Agent Ledger can display that a migration is required,
but it cannot apply one.

Do not experiment with setup or migration against your primary Vault. Use a
separate synthetic Vault until the runtime and configuration have been verified.

## Install Agent Ledger

1. Open **Settings → Community plugins** in Obsidian desktop.
2. Search for **Agent Ledger**, select **Install**, then select **Enable**.
3. Open **Settings → Agent Ledger**.
4. Enter the absolute path to the verified `work-ledger` executable.
5. If you use a non-default CLI configuration, enter its absolute path.
6. Open Agent Ledger from the ribbon or command palette.

The executable must work when launched by a desktop app that does not load your
interactive shell. Prefer an isolated-environment console script with an
absolute Python shebang. A zipapp using `/usr/bin/env python3` is suitable only
when Obsidian's environment resolves Python 3.11 or newer.

## Troubleshooting

### CLI missing

Confirm the configured path is absolute, nonempty, executable, and points to
the same entry you verified in a terminal. Do not rely on interactive `PATH`
initialization.

### Incompatible CLI

Run `version` and `capabilities` with the configured executable. Confirm the
version is within `>=0.8,<1.0`, protocol is 1, and the required snapshot and
clean-report-export capabilities are present.

### Vault mismatch

Agent Ledger compares the configured CLI Vault identity with the Vault open in
Obsidian. Open the configured Vault, or select a configuration for the current
Vault. Business state is cleared before the mismatch is displayed.

### Migration required

Use the CLI to generate and review a migration plan for schema 4. Apply only an
explicitly reviewed plan through the CLI; the plugin remains read-only.

### Stale data or fatal health findings

Open **Health**, resolve the CLI, schema, digest, or doctor finding, then refresh
manually. A stale snapshot remains visible after an ordinary refresh failure,
but a Vault mismatch clears business data.

## Read-only boundary

Through Work Ledger, Agent Ledger may inspect local Git metadata and history.
It never performs Git mutations, fetches, pushes, synchronization,
managed-Markdown writes, report writes, or migration apply. Project, Task,
Event, Report, CLI stdout, and copied Agent context stay in memory rather than
plugin settings.
