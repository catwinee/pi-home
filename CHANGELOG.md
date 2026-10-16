# Changelog

## 0.2.2 — Compact startup updates

- Remove the redundant startup `[Workspace]` section; leave cwd display to Pi's footer. Preserve `/workspaces`, cwd filtering and the read-only artifact inventory.
- Replace recognized Pi 1.2.0 native update boxes with a yellow version-line `update available: v…` and a yellow `↑` after the Extensions count. Show nothing pending; reuse native asynchronous results without extra network requests, timers or disk state. Preserve editor drafts, Ctrl+O, unrelated warnings and same-process update results across reload/session changes; restore native rendering on disposal and leave unknown formats visible.

## 0.2.1 — Progressive startup

- Render the complete startup layout with unknown-value placeholders immediately; fill statistics and heatmap cells in place without a loading banner, animation or editor-focus changes. Reserve two model rows and ordinary metric widths; keep real warnings visible.
- Time-slice JSONL parsing, per-session cache validation/serialization and multi-range aggregation. Share lineage/order/dedup between Today and history, preserving date, cwd, fork and trash accounting. Cancel obsolete startup aggregation on session replacement/reload/shutdown and discard late results.
- Skip unchanged cache writes after normal discovery/identity checks, and avoid building event sets for an empty trash merge. Retain the v2 cache format and corrupt-cache recovery.
- Cache static overview layout by width/data with theme invalidation, while native resources remain live. Keep inventory scans on demand.
- Add synthetic regression coverage and isolated real-Pi before/after measurements with input during loading. Responsiveness improves; first-index completion can take slightly longer. Whole-cache JSON parsing and large atomic operations remain synchronous limitations.

## 0.2.0 — Workspaces and read-only inventory

- Make `/home` a session-browser entry rather than a second dashboard. Keep date/model/project/tool views on demand; remove UUID filler rows and add exact cwd filtering to sessions, searches and trash.
- Add `[Workspace]` to the native startup header, `/workspaces` for cwd selection, and `w` / `a` from the browser for workspace selection / associated file locations.
- Add `/artifacts [all]` with bounded metadata-only inventory of session storage, known pi-subagents session/current-project/user-temp paths, and pi-home cache/trash. Show logical bytes, file counts, mtime, largest direct children, association evidence and shared/unassigned locations.
- Inventory never parses artifact bodies or refreshes the text cache, never recurses arbitrary project/home/temp directories, and has no deletion action. Display explicit partial lower bounds, skipped symlinks, limits and diagnostics; support cancellation and explicit refresh.
- Add isolated census/UI/command/PTY regressions. Known-path coverage is intentionally limited; recorded cwd is not proof of artifact ownership or permission to scan a historical project.

## 0.1.2 — Native startup layout

- Replace the redundant startup widget with a compact custom header that reuses Pi's exact colored icon/version. Put native resource counts on the old shortcut-hint row and retain the expansion hint.
- Fold ordinary resource inventories by default; preserve actual conflicts/errors. Native Ctrl+O expands help/resources; `/home resources` shows a scrollable read-only inventory without transcript spam.
- Add a narrowly scoped Pi 1.2.0 native UI adapter with version/layout guards, unknown counts for suppressed inventory, and disposal restoration. No installed-core or user-settings edits; unsupported layouts and existing custom headers are left unchanged.
- Keep all startup metrics and heatmap in a single column: native-colored `[Today]` followed by `[Activity]`, separated by a blank line. Short terminals scroll rather than omit content; empty-session reloads are supported.
- Compress Today into `messages/replies/tools/errors` and `↑/↓/CH R/W/cost` lines with gray labels and brighter gray values; omit new/active/nested details from startup. Remove fake minimum-length bars for zero-token model buckets; label real unattributed tokens clearly and show token counts/shares using all models as the denominator.
- Add native presentation/resource tests and real 80×24 / 60×24 startup acceptance coverage.

## 0.1.1 — Stability pass

- Fix default recursive JSONL discovery treating `subagent-artifacts/*_transcript.jsonl` as corrupt sessions. Default storage scans one cwd level, custom/current dirs are flat, deeper child logs require explicit `recursiveSessionRoots`.
- Probe bounded headers before parsing; distinguish artifacts, pending writes, genuinely damaged/unsupported sessions. Read legacy v1/v2 without rewriting; rebuild old cache.
- Add read-only Diagnostics (`i`, `/home diagnostics`) with scan scope/timing and details. Do not dump scan warnings or action failures into chat after quitting.
- Keep browsing usable with damaged trash/lease records; retain fail-closed mutations. Reject deletion of partially written sessions. Safely complete interrupted restores with identical hardlinks, detect changed trash payloads, verify cross-filesystem failures preserve originals.
- Fix cwd filtering before fork dedup and lost historic usage when a new session occupies a trashed original path.
- Fix selecting different trash versions at the same path and preview jumping back to search hits after resize.
- Avoid transcript work for empty queries, reuse text search indexes and concurrent scans.
- Add realistic plugin-layout, interrupted-operation, accounting, diagnostics and PTY regressions plus a reproducible synthetic benchmark. See docs/VALIDATION.md.

## 0.1.0

Initial local-first TUI, welcome summary, heatmap, usage accounting, session search/preview/resume and recoverable deletion, adapted from pi-stats-ext.
