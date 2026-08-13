# Contributing to Agent Ledger

Agent Ledger is the Obsidian client for the Work Ledger CLI and Vault contract.
Plugin-facing copy uses the Agent Ledger name; executable, protocol, schema, and
managed-data identifiers remain Work Ledger.

## Development requirements

- Node.js 20, 22, or 24; use Node 24 for the release-equivalent local path.
- npm with the committed lockfile.
- Python 3.11 or newer and Git when running CLI contract tests.
- A separate synthetic development Vault. Never develop or test against a
  personal production Vault.

Node 25 is outside the supported range because its macOS worker runtime can
crash while Vitest starts.

## Install and verify

From the plugin directory:

```text
npm install
npm run verify
```

Verification runs ESLint, Vitest unit and CLI contract tests, TypeScript,
esbuild, and packaging. A successful package is written to:

```text
dist/agent-ledger/
├── main.js
├── manifest.json
├── styles.css
└── SHA256SUMS
```

Copy `main.js`, `manifest.json`, and `styles.css` into the synthetic Vault at
`.obsidian/plugins/agent-ledger/`, reload Obsidian, and enable Agent Ledger.

For repeatable verification in the real desktop runtime, use the repository-local
synthetic Vault workflow in [Local real-Obsidian verification](docs/local-e2e.md).
It installs the packaged plugin, connects to the real Work Ledger CLI source, checks
the live Electron DOM, captures screenshots, and verifies that `Work/**` remains
unchanged.

## CLI contract tests

In the monorepo, contract tests automatically use the sibling Work Ledger CLI
source tree.

A standalone community clone has no sibling CLI source. Install the
`work-ledger` console script from an exact `agent-ledger-harness` release on
`PATH`, or set `WORK_LEDGER_TEST_EXECUTABLE` to an absolute, nonempty executable
path before running verification:

```text
WORK_LEDGER_TEST_EXECUTABLE=/absolute/path/to/work-ledger npm run verify
```

The standalone community path must resolve a production-compatible
`work-ledger-cli` product. Do not make tests depend on an editable checkout,
TestPyPI, or interactive shell initialization.

## Product screenshots

Public README screenshots live in `docs/assets/readme/`. Capture the implemented
UI at 1359x768 in a synthetic Vault, use fictional data, and verify there are no
personal project names, task names, paths, repository details, or other private
identifiers. Keep the files tracked by Git LFS, hydrate the working tree before
verification, and confirm the immutable release snapshot contains true PNG
payloads rather than LFS pointer text.

## Release boundary

Do not hand-edit `manifest.json`, package versions, `versions.json`, the
changelog release marker, or `.release/obsidian.json` for an ordinary feature
change. After the feature PR merges, the component-release controller prepares
the dedicated patch Release PR.
