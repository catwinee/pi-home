# Validation (0.2.2)

## Inline update notifications

- Synthetic regressions cover pending/no indicators, independent core/package arrivals, yellow styling, unchanged wide-screen section geometry, narrow widths, optional release notes, OSC 8 changelog links, complete-sequence recognition, lookalike chat prose and unknown-format fallback.
- Disposal restores original instance methods/renders while respecting later wrappers. Resource-only overlays and unsupported versions leave notices native. Results survive native transcript clearing and reattachment; input redraws do not rebuild or rescan notification text.
- Real fullscreen and regular Pi 1.2.0 PTYs run `--offline` with isolated HOME/agent directories. A test-only preload invokes the actual native `showNewVersionNotification` and `showPackageUpdateNotification` methods after explicit fixture-file signals; it does not simulate the final header text or contact update endpoints. Checks confirm delayed inline results, absent native boxes/notes/package lists, preserved Chinese editor drafts, stable Activity row, unaffected unrelated warnings, Ctrl+O and update persistence across `/reload` and `/new`.
- Production code adds no network requests, polling, disk cache or installed-core changes. The native in-memory header retains only a version string and package-update flag for the life of the Pi process.

## Progressive startup

- Synthetic regressions cover pending/ready section geometry, honest unknown placeholders, zero/one/multiple model rows, long/CJK model names, narrow widths, error presentation, live native resources, and layout-cache invalidation for width/data/theme changes.
- Lifecycle tests cover immediate pending presentation, reload, new-session and shutdown races; obsolete work cannot publish into a replacement header. Cooperative-runner tests confirm real event-loop turns during processing, cancellation and generator cleanup; multi-range aggregation is checked against existing accounting expectations and synchronous output.
- Cache tests verify unchanged bytes/inode/mtime on warm hits, changed/deleted sessions, known damaged paths, missing/corrupt/legacy caches, unchanged v2 serialization, and large single-session partial tails. Existing mutation-safety tests remain applicable.
- Real Pi smoke waits for actual message counts, not `[Activity]`, since headings now appear before statistics. Fullscreen/regular, Ctrl+O, reload, resource warnings, narrow resizing, inventory read-only behavior and session operations remain covered.
- An additional isolated PTY A/B used the `bf01b29` source snapshot versus v0.2.1, Node 26.11.1 / Pi 1.2.0 on the same Linux host, 110×56 fullscreen. Each variant had a separate initial runtime-compilation warmup. Five measured rounds alternated before/after order, using the same 1,000 synthetic sessions (25 JSONL entries each, 11,352,400 bytes). Fresh means no extension JSON cache, not cold OS page cache. No real histories, credentials, plugins or model requests were used.
- Readiness required an executed probe command, not terminal output alone. Overview completion required `messages 12000` plus the heatmap; the skeleton did not count as completion. During loading, a synthetic draft with Chinese text was repeatedly extended and checked after rendering. All measured after-runs observed the skeleton, preserved the draft and retained the Activity row position. Screen polling includes approximately 8 ms polling plus tmux/redraw overhead.

Medians (each row n=5; milliseconds):

| Measurement | Before, fresh index | After, fresh index | Before, warm index | After, warm index |
|---|---:|---:|---:|---:|
| Command usable from process exec | 722.0 | 736.8 | 728.5 | 734.3 |
| Pending full layout visible | — | 666.7 | — | 665.5 |
| Complete overview | 1320.8 | 1370.6 | 1039.9 | 972.1 |
| Maximum event-loop delay per run, measured after session_start | 140.4 | 18.2 | 134.6 | 46.9 |

The no-pi-home baseline had a 643.5 ms median command response. Fresh overview completion increased by about 50 ms while the long stall decreased substantially; warm completion improved by about 68 ms. This is a responsiveness change, not a claim of universally faster startup or a hard 6 ms latency bound. The remaining warm-cache pause is consistent with unsliced JSON parsing. End RSS medians were approximately 284→296 MiB fresh and 328→283 MiB warm, but neither peak nor retained heap was measured. Individual input echoes in this small experiment peaked around 123→25 ms fresh and 123→69 ms warm; these are polling-based observations, not a production p95/p99 latency guarantee.

The isolated scripts, raw samples and before/after pane captures are retained locally under `~/.local/share/pi/artifacts/unassigned/pi-home-progressive-58k5sS/` (`ab.py`, `harness.py`, `probe.ts`, `ab-results.json`, `ab-summary.txt`). They are not packaged or committed. No snapshot-cache migration, worker or eager inventory scan was introduced.

## Workspace / read-only inventory

- `/home` now opens the session browser, not another dashboard. Tests cover exact cwd filtering of sessions/search/trash, clearing filters, no UUID filler, and workspace/artifact action intents.
- Synthetic inventory fixtures include shared session storage, an invalid conversation body behind a valid header, oversized/future/malformed headers, known project and temp artifacts, unknown subtrees, orphan artifacts, invalid cache/trash JSON, symlinks and cycles. Headers and metadata suffice; artifacts and damaged cache/trash contents are not parsed or repaired.
- Before/after filesystem fingerprints verify no content, permissions, names or mtime changes. Command-level tests verify `/artifacts` and `/workspaces` do not rewrite the full-text cache or queue notifications. Unselected historical project paths and unrelated project files are outside scope.
- Entry/depth budgets, permission failures, aborts, exact-root overlap and bounded largest-child displays have regression coverage. Partial values are identified as lower bounds. Root/cwd association is not file ownership or a deletion safety assertion.
- UI tests cover cwd search in Chinese, selection preservation, detail scrolling, scope diagnostics, absence of delete actions, loading cancellation and very narrow widths.
- Real Pi PTY coverage verifies the absence of the redundant `[Workspace]` section and exercises cwd selection into the existing browser, returning from the picker without losing the cwd filter, artifact details/scope, and the cache/artifact bytes remaining unchanged after `/artifacts`. Its `PI_SUBAGENTS_TEMP_ROOT` is isolated as well as HOME/agent dir.
- No scan of production session bodies or artifact directories was used to validate this implementation. Validation did not change user configuration or installation; commits and pushes require explicit user authorization.

## Startup redesign

- Reuses native colored glyphs/version, replaces only the compact help sentence with native inventory counts, and retains the native expansion hint. No generic onboarding prose in the collapsed header.
- Unit tests cover exact ANSI logo reuse, package/scope-aware counts (including commas/CJK), unknown counts under quiet startup, unsupported-layout fallback, other custom headers, late resource refreshes, expansion-state preservation, disposal restoration and scrollable resource details.
- Real Pi 1.2.0 PTY tests exercise both fullscreen and regular startup, Ctrl+O expansion/collapse, `/home resources`, `/reload`, startup on/off, and synthetic skill-conflict warnings remaining visible while ordinary resource lists fold.
- Startup is single-column at all widths, with unbolded native `mdHeading` titles `[Today]` then `[Activity]`. Unit tests check section order, spacing, colors, no column divider and retention of all metrics. Real fullscreen tests check the full header/metrics/heatmap at 80×40, then the heatmap remains visible after resizing to 80×24 and 60×24; upper content can require native scrolling. These layout fixtures use an unused dummy local model entry to avoid the large no-model onboarding warning; no model request or real credential is involved.
- With genuine resource/provider warnings, their text is deliberately preserved and can require scrolling. Arbitrarily tiny windows are width-safe, not guaranteed to fit the whole dashboard at once.
- Compact Today tests check two metric lines at wide widths, gray-label/brighter-value ANSI styling, omission of new/active/nested details, and lossless wrapping on narrow screens. Model-bar regressions exclude zero-token buckets without discarding unknown-usage warnings, retain real unattributed tokens, and calculate top-two shares against all models rather than just displayed ones.
- All new acceptance fixtures are isolated; no real user settings, sessions or extension installation were changed.

## What was reproduced

The original scanner recursively treated every `.jsonl` under sessions as a Pi session. A realistic fixture now includes:

```text
sessions/
  --project--/
    main.jsonl                        # real Pi session
    subagent-artifacts/
      run_worker_transcript.jsonl     # NOT a Pi session
      run_reviewer_transcript.jsonl   # NOT a Pi session
    session-id/forks/child.jsonl       # genuine but outside default scope
custom-child-root/
  run-id/run-0/session.jsonl           # genuine, explicit recursive root
  run-id/worker_transcript.jsonl       # not counted even when recursive
```

The usage-index discovery never opens the artifact subtree (the new explicit inventory command performs a separate metadata-only census there). Explicit recursive scanning recognizes sessions by a bounded header, not by file extension alone. The tests include an unreadable artifact to detect accidental body access, corrupt native/previously indexed headers, BOM, older formats, unknown future formats and incomplete writes.

A metadata-only check against the user's actual default session directory and reported project directory found **165 candidate paths, 2 out-of-scope directories, 0 artifact candidates, 0 directory-read warnings**. It did not read conversation bodies, change user caches, delete sessions, or rewrite originals. This establishes the reported path is excluded; it is not a claim that all real session contents have been validated.

## Automated checks

- `npm run check`: strict TypeScript and **111 synthetic tests**, all passing.
- `npm run smoke`: real Pi 1.2.0 in a private tmux server; fullscreen and regular modes. All passing.
- `npm run pack:check`: package includes runtime source, license/attribution and docs; no fixtures or private data.

New safety regressions cover:

- Default-Cancel, cancellation of session replacement, stale preview identity and fresh-context-only deletion.
- Partial final record deletion refusal, corrupt activity registry fail-closed behavior.
- Unreadable/corrupt trash metadata does not make the Home browser unusable; payload remains intact.
- Crash-state simulation before payload move and after restore link creation.
- Changed trash payloads remain available for manual recovery instead of silent restore.
- No-overwrite restore to a recreated path; same-inode interrupted restore can finish.
- Real EXDEV failure using `/tmp` and `/dev/shm` on this Linux host (conditionally skipped on hosts without a second writable filesystem).
- Fork dedup before cwd filtering, old usage retained when an original path is reused, duplicate restored copies counted once.
- Different trash versions with the same original path select correctly; resize does not re-jump a preview to the search hit.
- Scan warnings survive refresh in the diagnostics page but never become queued chat notifications after quit. The PTY test includes both the artifact subtree and an actual corrupt session fixture.

These tests do not prove safety against arbitrary uncooperative external writers. Cooperative active-session protection and the remaining filesystem race limitations are documented in README.

## Historical synthetic performance baseline (before progressive startup)

Command: `npm run benchmark` (default 1000 generated sessions, 25 JSONL entries each, 20 cwd values). Example run on this host, Node 26.11.1, Linux:

| Operation | Observed |
|---|---:|
| First scan including cache write | 629 ms |
| Warm scan including cache read/validation/write | 189 ms |
| Cached sessions reused | 1000 / 1000 |
| Empty query | 0.5 ms |
| First text query | 12.5 ms |
| Repeated text query (mean of 20) | 3.5 ms |
| One all-time aggregation | 72.3 ms |
| Home construction + 100-column render | 96.5 ms |
| Cache size | 14.7 MiB |
| Benchmark process RSS at end | 404 MiB |
| Expected / actual user messages | 12000 / 12000 |

This is a reproducible workload, not a promise for real histories. The benchmark retains both first/warm scan results and search indexes; RSS includes the TS/runtime/TUI and is not an isolated extension retained-heap measurement. Memory remains a limitation: full text is still held in memory, and a large single session or much larger history may block Pi during JSON parsing or layout. Worker parsing, incremental-on-disk text search and bounded conversation paging should be considered only after profiling those workloads. No unmeasured claim of "instant" or "unlimited history" is made.

## Deliberately not done

- No permanent/batch deletion, new daemon, browser UI or provider quota integration.
- No scan of the user's conversation bodies for this stabilization pass.
- No user configuration changes, automatic plugin installation or modification to upstream Pi.
