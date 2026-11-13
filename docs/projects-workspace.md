# Projects workspace (VEN-84)

The projects tab uses one complete accepted snapshot and one query for board,
list and tree. It remains read-only. The existing overview, timeline, Knowledge,
reports and health pages retain their current routes. Plugin/CLI versions remain
0.1.9/0.11.4; there is no release or business-schema migration.

## Implementation and review map

| Requirements | Implementation | Automated evidence |
| --- | --- | --- |
| OBV-001–005, AC-01–07,19,25: scope, intersection, dates, keyword and exact tags | `src/projects/spec.ts`, `dates.ts`, `query.ts`; complete snapshot index | `tests/projects/query.test.ts`, `tests/unit/protocol.test.ts` |
| OBV-006–008, AC-08–11,21–24: groups, sibling sorting, M + ancestor context, Leaf-local selection and keyboard | `workspace.ts`, `workspace-view.ts`, `virtual-list.ts` | query + interaction tests; 10k End reaches the final logical task with bounded DOM |
| OBV-009, AC-12–13,16–17,20: saved views, restore, explicit migration | `preferences.ts` | `tests/projects/preferences.test.ts`: CRUD, 50 limit, Unicode names, file/item conflicts, atomic failure, identity recheck at commit, latest Leaf owner, future formats and import receipts |
| OBV-010, AC-14: empty, stale, unavailable timezone and connection states | workspace model/view, refresh controller | query, interaction and refresh-controller tests |
| OBV-011, AC-15: capacity and windowing | virtual list + benchmark tools | synthetic CLI samples and Node CPU samples; desktop performance acceptance remains open |
| OBV-012–013: host styles, readonly detail, compatibility | view integration, scoped detail reader | interaction, protocol, package-boundary and CLI-contract tests; browser preview is supplementary |
| OBV-014, AC-18: usability and acceptance record | issue evidence and this guide | representative-user and screen-reader sessions remain required |

The independent preference file lives under the current Vault's `configDir`, in
`plugins/<manifest.id>/project-workspace-preferences.v1.json`. Only ViewSpec,
names, IDs, revisions, binding metadata and migration receipts are persisted.
There are no task bodies, cached results, selections, CLI paths or business
writes. A shared queue, exclusive lock, revisions and fsync/temporary-file rename
protect updates. Unknown versions/conditions stay preserved and cannot broaden
an applied query. A leftover lock after a crashed process blocks saving; recovery
must verify that its owner is no longer running before removing that lock.

The repository's historical `savedFilters` format has no authenticated Vault
binding. These records always require explicit target/condition confirmation;
matching project IDs are not proof of origin. Import does not apply the view.
Unknown additional provenance fields are preserved in old settings and disable
import; no speculative authenticated legacy format is invented.

Use **Use legacy projects page** in plugin settings to return to the previous
page. Both preference formats remain intact. Disable that switch to resume the
new workspace. No dependency or published version change is required.

## Repeatable capacity probe

From the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3.12 packages/work-ledger-obsidian/tools/benchmark-projects.py
```

The script creates a fresh synthetic Git Vault in the checkout-specific external development directory,
initializes the real CLI schema, and writes canonical fixture notes with the CLI's
Markdown serializers. It never opens the user's configured Vault. Each of two
fixtures has 100 projects, 10,000 tasks, six statuses, four priorities, null/boundary
dates, a 16-level chain, and 1,000 events in the emitted snapshot window. Projects
include Inbox and archived entries. The pressure fixture uses long Chinese titles
and 16 tags per task. Knowledge/report collections are empty in this probe;
50-view capacity is covered separately by the preference test.

Use the printed directory for the frontend probe, from the plugin directory:

```sh
node tools/benchmark-projects.mjs /absolute/printed/capacity/<run-id>
```

`cli-results.json` reports three separate process samples, output bytes and peak
RSS on macOS. These are not Obsidian cold-start measurements or a CLI P95.
`frontend-results.json` reports 30 samples after five warmups per scenario, with
raw timings and nearest-rank P95 (29th sorted sample). It measures JSON decode,
validation/indexing and query/group/tree CPU separately. It excludes DOM, IPC,
input debounce, paint and Electron overhead. Do not label it end-to-end latency.

Observed on Apple M4 / 24 GiB, macOS 26.6.2, Python 3.14.5, Node 24.16.0:

| Fixture | stdout bytes | CLI elapsed (3 samples) | Peak RSS |
| --- | ---: | --- | ---: |
| ordinary | 6,832,555 | 1290.40 / 1335.01 / 1316.88 ms | 151,109,632 bytes max |
| long Chinese + 16 tags | 17,707,555 | 1691.81 / 1524.78 / 1494.21 ms | 185,565,184 bytes max |

The pressure fixture exceeds the existing 16 MiB process limit by 930,339 bytes.
The plugin retains the existing limit and 10-second timeout, reports
`CLI_OUTPUT_LIMIT` clearly, and never displays a partial snapshot. TL must confirm
any limit adjustment and associated memory budget. No AC-15 pass is claimed.

For acceptance, freeze device/OS/runtime/data/thresholds with PD/TL first. The
approved proposal is M1/8 GiB and a Windows target, five warmups plus 30 samples
per filter/layout/group, measuring input to actual paint (including 200 ms keyword
debounce), nearest-rank P95 and raw slow/failure samples. Measure peak heap, DOM,
long tasks, current-revision detail and repeated-switch memory separately.

## Desktop verification (2026-11-13)

Repository `AGENTS.md` requires final committed clean HEAD and
`python3 -m tools.dev_harness pre-pr --base origin/main`, including real desktop
Knowledge E2E. Kevin Lee clarified on 2026-11-13 that Obsidian 1.13.6 is the
minimum acceptance runtime, not an exact version freeze. Runtime 1.13.7 now passes
the real Knowledge E2E on this checkout's isolated Vault, with inspected visible
window screenshots. The previous CLI and accessibility blockers have cleared.

A separate synthetic Vault loaded all 10,000 tasks through the real CLI. Desktop
checks covered six board columns with 60 mounted tasks, list End reaching the
visible final task with 17 mounted rows, current-revision detail and focus return,
and a tree with one match plus 15 ancestor contexts. A real ResizeObserver/range
change exposed a focus loss: the viewport now retains logical focus ownership
until its row remounts. An added regression fails before this fix and passes after.

Saved views survived plugin reload and a complete Vault renderer reload. A real
pop-out used a separate document and independent layout; legacy fallback retained
preferences. Host light and dark themes were checked; the 700px dark window had
700px document width (632px workspace). Runtime error/console captures were empty.

On M4 / 24 GiB, macOS 26.6.2, Obsidian 1.13.7 / Electron 43.3.0 / Chromium
150.0.7871.212, a visible 1380×900 window used five warmups and 30 samples per
operation. Timing starts before dispatching a UI event and ends after accepted
query/layout state plus two animation frames; keyword timing includes the 200ms
debounce. Layout/group samples retain 10,000 matches; keyword alternates 100 and
10,000. These are renderer event-to-frame measurements, not physical display or
cold-start timings. Raw samples are attached to VEN-84.

| Desktop operation | P50 | P95 (29th of 30) | Maximum |
| --- | ---: | ---: | ---: |
| Layout | 33.3ms | 33.8ms | 34.5ms |
| Group | 33.3ms | 34.9ms | 35.2ms |
| Keyword | 250.0ms | 251.1ms | 251.4ms |

All 90 measured operations completed without error; aggregate P95 (86th of 90)
was 250.0ms. The largest sampled JS heap was 157,100,244 bytes, not a process-wide
peak-memory bound. AC-15 thresholds/reference hardware remain unconfirmed, and
the long-title 16MiB capacity limitation above remains. Windows, VoiceOver,
third-party themes, zoom, full application restart, performance traces/long-task
analysis and representative-user usability sessions still need acceptance work;
these measurements do not claim every AC is complete.

For concurrent local checkouts, set a unique `WORK_LEDGER_E2E_VAULT_NAME` consistently
for setup, install, verification and the harness. The default remains unchanged.
A mismatched fixture marker is rejected instead of silently using another Vault.
Never target a personal or another checkout's synthetic Vault.
