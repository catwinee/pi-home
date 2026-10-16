# Design notes

## Scope

Pure Pi TUI. No HTTP server, browser, daemon, model calls, credentials, telemetry or core-file patches. Public APIs for lifecycle, commands and UI installation, with one explicitly version-gated Pi 1.2.0 presentation adapter (see below). The startup header is the only overview. `/home` defaults to the session browser; `/workspaces` groups saved sessions by recorded cwd; `/artifacts` is a separate, read-only location census. Session mutations still require a safe command context. Explicit session resumes are not intercepted.

## Source attribution

The design is based on pi-stats-ext v0.2.0, revision `572574a039fe7bba4af6caceea4ba0af6067f5b0`. Incremental per-file JSON caching, aggregating usage into date/model/project buckets, number formatting and graded calendar layout were adapted. We did not retain the cost-efficiency recommendations or assume assistant usage was the whole workload.

`NOTICE` identifies upstream source; `LICENSE` preserves its MIT license. New source implements session browsing, safe cleanup and lifecycle integration. The repo's origin is catwinee/pi-home; upstream is irfansofyana/pi-stats-ext. No need to modify installed packages.

## Modules

- `discovery.ts`: flat / grouped / explicitly recursive discovery roots, bounded header probes and structured info/warning diagnostics. No universal recursive JSONL glob.
- `stats.ts`: safe text extraction, JSONL parsing, per-file incremental cache, local-time date arithmetic, lineage-aware dedup, aggregation, substring search with snippets. Shared generator implementations support synchronous callers and cooperative startup work without separate accounting algorithms.
- `cooperative.ts`: a soft 6 ms work-slice runner using real event-loop turns (not only microtasks), with optional abort and generator cleanup. No persistent timer or worker.
- `heatmap.ts`: bounded calendar using local-day arithmetic, no DST drift.
- `native-startup.ts`: Pi 1.2.0-only compatibility boundary. A zero-height, immediately removed public widget factory exposes the TUI reference before changing anything. Recognize the native header/document layout or leave it alone. Reuse native colored logo/version/help, read native expanded resource leaf rows for counts, and wrap the resource-container instance's render method to fold normal listings. Once a replacement header is installed, observe the transcript instance's `addChild` to recognize the exact complete native update-notice component sequences (spacers, borders, ThemedText and optional Markdown). Hide only those instances' renders and publish the version/package flag in the header, retaining the transcript components unchanged. No scans on input redraws: inspect existing children once, then at most eight trailing components per append. Two positive results live on the native header under a namespaced symbol so runtime replacement does not discard them; there is no polling, separate update request or disk cache. Resource-only overlays do not activate this observer. All unrelated warnings and unrecognized sections/notice formats remain visible. No new ResourceLoader, core file/prototype patch or settings mutation. Disposal restores owned instance methods/renders without overwriting later external wrappers; external header replacements are respected. Disabled native listings are unknown (`?`), not zero; unsupported versions/layouts keep Pi's presentation.
- `startup.ts`: expandable custom header using native Ctrl+O propagation, responsive activity/metrics layout, and a scrollable read-only resource panel. Fresh launches and empty reloads first show a static skeleton, then fill an activity snapshot; resumed conversations/new sessions get only the compact header. Unknown metrics/calendar cells use `—`, not zeroes. Two model slots and normal metric widths keep the usual layout stable; exceptional values and diagnostics may grow. Overview layout is cached by width/data and cleared on theme invalidation; native resource snapshots remain live. No transcript insertion, animation, editor ownership or model activity.
- `inventory.ts`: separate bounded, read-only metadata scanner; no conversation cache dependency or writes. Header cwd is a grouping label, not a filesystem traversal grant. Tracks logical file sizes, direct-child distribution, evidence, shared association, unknown subtrees, skipped links and partial results.
- `workspaces.ts`: cancellable loading, cwd picker and scrollable location/scope/detail views. Only close/refresh/open-filtered-session intents; no deletion/file-opening/shell action. Shared locations are independent of cwd selection.
- `home.ts`: session-browser-first, theme-aware, height-bounded keyboard UI with an exact optional cwd filter, no duplicate dashboard and no UUID filler row. Uses Pi `Input` for Unicode/IME, bracketed paste and key parsing. It returns action intents; it does not mutate files or switch sessions itself.
- `store.ts`: config/paths, live-process registry, checked trash moves and no-overwrite restore. Deletion lock serializes participating processes. Metadata survives a crash before or after the payload move.
- `index.ts`: Pi lifecycle and user commands. Holds UI state outside each modal so confirmations/refreshes preserve the search/selection/preview. Closes the modal before calling Pi dialogs or switching sessions. Uses `withSession` only for post-switch work on a fresh context.

## Accounting

JSONL is source of truth; cache can be discarded. Cache includes text but not images/signatures/system prompt. A scan never loads sessions with SessionManager (which could migrate/rewrite data). It uses raw reads, validates file identity before/after parsing, does not follow symlinks, and reports unreadable or malformed sources. Root overlaps are deduplicated.

Each event carries counts and observed usage. Summaries and tool model calls may lack provider/model fields; their usage remains unattributed. Per-field missing token metrics are flagged. Unknown fields are tolerated. Independent `usage.kind` values are not filtered by a hard-coded enum.

Dedup is bounded to a parentSession lineage. Entry ID + message timestamp + payload fingerprint identifies inherited records even if Pi re-chained parentId. Ancestors precede descendants during attribution. Unrelated sessions with coincident IDs/messages remain separate. Entries without IDs deliberately do not dedup. Manual exports/imports that discard lineage cannot be perfectly reconstructed.

Trash metadata preserves events and creation metadata (not transcript text); its JSONL supplies on-demand trash previews. If an interrupted restore leaves both live and trash paths for the same session and events, the live copy wins for accounting. A new session recreated at an old path does not suppress the old trash usage. Cwd filters run after lineage dedup, not before it. Raw preview includes all branches; statistics count historical workload rather than only the active context projection.

## Safety boundaries

The interactive preview is not `resume`: it has no hooks, project resource loading or model requests. Terminal control sequences are removed before indexing/rendering. Search never executes regex or historical commands.

The UI cannot call a deletion without returning to the command handler. The handler checks that the preview's file identity still matches, obtains a fresh ticket, asks for confirmation (Cancel first), then the store rechecks before moving. The active-session registry is cooperative, not an OS-enforced lock. Other tools/processes can still race the final filesystem operation. This limitation is exposed in every confirmation and the README.

`/delete` captures immutable data before switching and deletes only after replacement, inside `withSession`. On cancellation it does nothing. On deletion failure after switching, the fresh UI reports the failure and the original/recovery-copy locations without claiming that the original path necessarily still exists. The command never exposes an arbitrary path argument or model-callable deletion tool.

Restore uses `link` with no-overwrite semantics before unlinking the trash payload, rather than `rename` over the original path. If the original is already the exact same inode/dev/size/mtime, it completes an interrupted restore; otherwise it refuses to overwrite. Changed trash payloads are held for manual inspection. Invalid trash/lease state is exposed inside Diagnostics while browsing remains available, but mutations fail closed. Incomplete final JSONL records cannot be deleted. Cross-filesystem moves are rejected. No permanent deletion command, purge timer, auto-created system service or trash retention timer.

## Performance / limitations

- First index only scans candidates within configured boundaries. Subsequent scans use mtime + size + inode; file truncation/rewrite rebuilds instead of preserving stale counts. Cache v2 also remembers recognized paths so a corrupt custom-named session remains diagnosed on repeated refreshes.
- Startup and Home share identical in-flight scans. Empty search does not touch transcript text; non-empty searches lazily reuse lowercased document indexes rather than concatenating all transcripts on each keystroke.
- Refresh is explicit; no long-lived file watcher or recurring task. Scanning yields between JSONL records and cached sessions. Cache v2 remains a single JSON file: validation and serialization are sliced per session, but whole-cache JSON.parse, individual large records, array sorting/string joining and GC cannot be preempted. Very large histories/files can still block input; no worker or new index format is introduced.
- All cached identities and known paths must remain unchanged to skip rewriting the index. Discovery/stat, diagnostics, removed-file detection and invalid/legacy-cache recovery still run. Cache writes retain private permissions and atomic rename. Empty trash merging returns a shallow copy without building unused event sets; nonempty trash retains event comparison.
- Startup aggregates Today/history together, sharing lineage/order/dedup and yielding between events. Session replacement/reload/shutdown cancels the obsolete aggregation; generation/disposal checks prevent late UI publication. Shared in-flight scans may finish for other consumers, so cancellation is not permission to discard another caller's scan. On-demand Home statistics retain their synchronous API.
- Startup work trades some total completion speed for input/render responsiveness. The skeleton requires no statistics or artifact scan; results are published only when complete. No extra snapshot cache is maintained. See VALIDATION for measured cold-index/warm-index tradeoffs rather than treating the work-slice budget as a hard latency guarantee.
- Plain text preview (not native Markdown, image or formula rendering). It lays out and caches a selected conversation by width; large conversations cost memory. Images remain placeholders.
- No batch deletion, export, tags or session renaming yet. Resume and native `/name` remain available.
- Date filters govern statistics; session search is all-history, with selected/current/all cwd scope. Model/project views show all rows via scrolling, not just top-N.
- Custom config is intentionally small; invalid config falls back to safe startup/default roots rather than granting arbitrary filesystem mutation.
- A process crash may leave a stale cleanup lock. It is not automatically stolen, since lock reclamation can introduce an unsafe second writer.

## Diagnostics

The default agent sessions root scans only its direct files and one cwd-directory level, matching the useful scope of Pi's `SessionManager.listAll()`. Custom/current roots are flat, matching `SessionManager.list()`. Deeper fork/run directories require explicit `recursiveSessionRoots`. The recursive escape hatch still checks a bounded first record before reading a body; ordinary artifacts do not become sessions or generate corruption warnings.

Header probes distinguish genuine sessions, non-session JSONL, recognizable corruption, pending writes and unsupported versions. Known session paths and native file names provide evidence for lost-header diagnostics; arbitrary malformed artifact names cannot always be distinguished from previously unknown corrupted sessions. No claim of perfect recovery is made.

Diagnostics are structured, read-only and scoped to the panel. The panel contains warnings, ignored/pending counts, roots and scan timing; it does not queue notifications that appear after quit. Action failures stay in the panel with a details link. Refresh replaces scan diagnostics rather than accumulating duplicates.

## Read-only inventory scope

Inventory is deliberately separate from the full-text index. It reads only a bounded first JSONL line (64 KiB maximum, 1 KiB chunks), validates it, and groups session file metadata by exact header cwd. It does not read or rebuild `cache.json`, parse trash record contents, or call `activePaths` (which can remove stale leases).

Known plugin paths are based on the inspected pi-subagents session/project/UID-temp layouts. Only the current runtime cwd's explicit `.pi/subagents/{artifacts,chain-runs}` directories are candidates; historical cwd strings never trigger project traversal. Session-directory artifacts have directory-level cwd association, possibly multiple or none. Temporary plugin data and pi-home cache/trash stay shared/unassigned. Unknown storage subdirectories are listed without traversal unless explicitly included in configured recursive session roots. Managed pi-home data is excluded from live session discovery even under overlapping roots.

The global inventory budget is 20,000 inspected entries, depth 6 and a soft 5-second deadline checked between async operations; a single filesystem call is not preempted. Esc/disposal aborts later work and prevents late UI updates. Census errors, depth/budget truncation and changed files produce partial snapshots/lower bounds; detail lists retain the 100 largest direct entries without reducing aggregate counts. Exact duplicate session paths are not counted twice. Hardlinks count by path, not physical blocks; no global total of potentially overlapping locations is advertised. Stable symlink ancestors, symlink entries and special files are not traversed/read, but checks are not a race-proof OS sandbox.

This feature is location discovery, not garbage collection: no retention policy, delete/undo/purge action, running-agent safety determination, guessed shell-output ownership, arbitrary directory picker, or plugin execution. Existing session deletion remains a separate explicitly confirmed operation.

## Verification

`npm run check` validates TypeScript and isolated synthetic tests: local dates/DST, missing/extra usage, lineage dedup, malformed cache/JSONL, Chinese search, terminal safety, narrow layouts, preview navigation, cancellation, active/current file protection, TOCTOU identity changes, no-overwrite restore and fresh-context deletion.

`npm run smoke` launches the locally pinned Pi in a private tmux server with isolated HOME/agent resources and networking disabled. It exercises startup, `/home`, preview, default-Cancel, trash/undo, resume, `/delete`, restore, Chinese search, resize, startup settings, and both fullscreen/regular modes. It never calls a model. Failed fixtures are retained under the reported temporary directory; successful runs clean up their own data.
