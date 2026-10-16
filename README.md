# pi-home

A startup overview, session browser, cwd navigator, and read-only artifact inventory for Pi. Adapted from the incremental indexing, aggregation, and heatmap implementation in [pi-stats-ext](https://github.com/irfansofyana/pi-stats-ext), with its MIT attribution preserved. It does not patch Pi's installed core files or replace `/resume`.

**Main workflow: select → read-only preview → decide whether to keep it → move to trash → inspect the next session.** There is no need to resume a session just to inspect it. After resuming a session, you can also use `/delete` directly.

The startup overview and management tools are separate; there is no second Home dashboard:

```text
[Today]
  messages 18 replies 51 tools 92 errors 2
  ↑ 120k ↓ 18k CH R 950k W 12k cost $1.20
  Models tokens
  …

[Activity]
  …activity heatmap…
```

`/home` opens the session list. `/workspaces` selects sessions by their recorded working directory. `/artifacts` shows storage distribution only: **it has no artifact deletion action**.

## Install or try locally

Development and validation baseline: **Pi 1.2.0, Node ≥ 22.19**. The extension uses the current `@earendil-works/*` APIs; compatibility with older Pi versions is not promised.

From a local checkout:

```bash
git clone https://github.com/catwinee/pi-home.git
cd pi-home
npm ci --ignore-scripts
npm run check

# Load for this invocation only, without changing Pi settings
pi -e ./src/index.ts

# Install persistently after trying it
pi install "$PWD"
```

You can also install from Git:

```bash
pi install git:github.com/catwinee/pi-home
```

There is no published npm package. Do not load both a local copy and a Git-installed copy: their commands will conflict.

## Startup and commands

On a normal fresh Pi launch, pi-home **replaces the startup header instead of adding a duplicate summary widget above the editor**:

- Keeps Pi's native colored icon and running version number. Resource counts replace the long shortcut sentence on the second line: `Context … · Skills … · Extensions …    /home resources`.
- Updates appear in place only after Pi's native asynchronous checks report them: `v1.2.0 update available: v1.3.0` on the logo/version line, and `Extensions 11↑` for package updates. The appended notice and arrow use the theme's yellow/warning color; existing logo/version/count styling stays unchanged. Initially neither indicator is shown—this does not mean the checks have finished or that everything is current. No spinner, extra check, timer or update cache is added. Narrow screens wrap the notice as needed.
- These inline indicators replace the two native update notification boxes, including their release note/package list. Other warnings and errors remain visible. The recognized results survive `/reload`, `/new` and session switches in the same Pi process; they are not saved to disk. Updating is still manual: `pi update` for Pi, `pi update --extensions` for packages. The arrow means native package updates are available, not that every loaded extension needs updating. Unsupported notification formats stay native; disabling startup or replacing the header restores native presentation for notices still in the transcript.
- Keeps `Press ctrl+o to show full startup help and loaded resources.` Pi's native binding expands and collapses help and resource lists; remapped shortcuts are reflected in the native hint.
- Leaves cwd display to Pi's footer; no redundant workspace section. `/workspaces` still filters sessions by recorded cwd without running `cd` or changing Pi's working directory.
- Shows the `[Today]` / `[Activity]` layout immediately, with gray `—` placeholders for unknown values and calendar cells rather than fabricated zeroes or a prominent loading message. Statistics fill in place without taking editor focus. Ordinary metric widths and two model rows are reserved to reduce layout shifts; unusually large values and genuine warnings can still add rows. Long model names are shortened in the startup summary; full names remain in `/home models`.
- `[Today]` shows message, reply, tool, and error counts, input/output tokens, cache tokens, recorded cost, and model bars. `[Activity]` follows after a blank line. The layout is always single-column, with native `mdHeading` colors, unbolded headings, indented gray labels (`dim`), and brighter gray values (`muted`).
- Today's counts and usage each occupy one line when space permits, wrapping on narrower screens: `messages … replies … tools … errors …` and `↑ … ↓ … CH R … W … cost …`. `↑/↓` mean input/output; `CH R/W` mean cache-read/cache-write tokens. New-session, active-session, and nested-call figures are omitted from startup; model/project/tool statistics remain available on demand.
- Model bars include only groups with recorded tokens greater than zero. They show token counts and shares of all models' recorded tokens, including cache tokens. Usage without model attribution is labeled `Unattributed`; attribution is not guessed. The heatmap is not removed just because the terminal is short: use Pi's native scrolling when content exceeds the viewport.
- Ordinary resource lists are collapsed by default, but **conflicts and loading failures remain visible**. `/home resources` opens scrollable read-only details, including prompts, without inserting the full inventory into the conversation.
- Does not steal input focus or replace the footer/editor. The startup snapshot remains after a conversation begins. Resuming, `/new`, and forking keep the compact header without regenerating activity statistics. `/reload` rebuilds the overview in an empty session; in an existing conversation it updates only the compact header.

**Compatibility boundary:** Pi's public extension API does not expose the complete loaded-resource inventory or a separate way to fold its native resource container. `src/native-startup.ts` is a **Pi 1.2.0-only** presentation adapter. It reuses native logo/help components and counts leaf rows in Pi's own resource inventory—no directory-based guesses or duplicate extension loading. Counts match Pi's visible inventory and exclude extensions Pi marks as hidden. It wraps only that resource-container instance's rendering and restores it on disposal/replacement; it does not edit installed Pi files, prototypes, or user settings. Unsupported versions/layouts and headers already owned by another extension are left unchanged.

Keep Pi's default `quietStartup: false` to make the inventory available for pi-home to fold. With `quietStartup: "header"`, Pi does not provide the ordinary inventory, so counts are `?` and the details explain why. Fully quiet startup is not forced to show a header. pi-home never silently changes this setting. Actual resource warnings can consume additional screen space; they are not hidden merely to preserve the layout.

Startup is not a modal dialog that intercepts input. Background JSONL parsing, per-session cache validation/serialization, and shared Today/history aggregation yield to the event loop between short work slices. Unchanged indexes are not rewritten. This improves responsiveness, not a guarantee of faster first indexing: parsing the complete JSON cache, unusually large individual records, sorting, and garbage collection can still cause pauses. No worker, extra snapshot cache, animation timer, or startup artifact scan is added. Session switching and deletion remain in the safe command contexts provided by `/home` and `/delete`.

| Command | Purpose |
|---|---|
| `/home` or `/home sessions` | Browse/search sessions directly, without repeating startup statistics |
| `/workspaces` or `/home workspaces` | Search recorded cwd values; Enter opens that cwd's session list |
| `/artifacts` or `/home artifacts` | Read-only inventory of known storage locations associated with the current cwd |
| `/artifacts all` | All discovered locations, including shared cache, trash, user-scoped temporary data, and unattributed artifacts |
| `/home models`, `/home projects`, `/home tools` | On-demand model, project, or tool statistics |
| `/home trash` | Preview and restore trashed sessions |
| `/home diagnostics` | Scan scope, timings, skipped entries, and actual problems; no warning flood after closing |
| `/home resources` | Native loaded-resource inventory and resource issues; scrollable, without reloading resources |
| `/home today`, `/home 7d`, `/home 30d`, `/home 90d`, `/home all` | Set a date range and open model statistics; retains the earlier date-command syntax |
| `/home 2026-07-01..2026-07-12` | Custom date range, including the end date |
| `/home startup off` or `/home startup on` | Disable/enable the startup header and overview on the next launch or reload |
| `/delete` | Confirm, switch to a fresh session, then move the previous session to trash |
| `/home undo` or `/delete undo` | Restore the most recently deleted session without resuming it |

Deletion is triggered only by explicit user commands/TUI actions. **No model-callable deletion tool is registered.** Management operations are refused while Pi is busy; they do not interrupt a generating response.

## Working directories and read-only artifact inventory

`/workspaces` groups sessions by the **exact cwd value in each session header**. It shows recognized session-file counts, logical bytes, latest file modification time, and storage directories. It does not parse conversation bodies or rebuild the search cache. The existing full-text indexing workflow runs only after you select a workspace and enter the session browser. The current cwd is shown even if it has no saved sessions yet.

`/artifacts` inventories these explicit locations:

- Configured session storage: `.jsonl` files with valid first-line headers. Other files and unknown subdirectories are listed separately as `unclassified`, which **does not mean garbage**. Unknown directory contents are not automatically traversed.
- `subagent-artifacts/` beneath those storage directories: file counts, logical sizes, modification times, and direct-child distribution, including measured subdirectories. Transcript, report, and metadata-file contents are not read.
- `.pi/subagents/artifacts/` and `.pi/subagents/chain-runs/` beneath **the current cwd only**. Historical cwd values in headers do not become automatic filesystem scan targets.
- Four known directories under pi-subagents' UID-scoped temporary root, `<os.tmpdir>/pi-subagents-uid-<uid>/`: `artifacts`, `chain-runs`, `async-subagent-runs`, and `async-subagent-results`. When `PI_SUBAGENTS_TEMP_ROOT` is set, only the same four children of that root are probed. Without a UID or an explicit root, no path is guessed. **The entire `/tmp` directory is never enumerated.**
- pi-home's `cache.json` and `trash/`, using filesystem metadata only. Trash is not a disposable cache.

Sessions are grouped by header cwd. Artifacts in session storage have a **directory-level association**, not proven ownership of each file. Storage associated with multiple cwd values is marked shared and represented by one location. If no session header establishes an association, it remains unassigned. Shared temporary data and cache/trash are not charged to the current project. Do not add a shared location once per workspace or treat the cwd directory itself as something safe to delete.

Press Enter on a location to inspect its full path, association evidence, latest modification time, and **direct children ordered by size**. At most the 100 largest children are displayed; aggregates still include the other inspected entries. Sizes are logical bytes summed by path, not allocated disk blocks. Hardlinks count once per path, and overlapping locations should not be summed.

The default budget for an entire scan is **20,000 entries, depth 6, and approximately 5 seconds**. The time budget is soft and checked between asynchronous filesystem operations; a single operation on a slow filesystem may exceed it. Budget limits, permission failures, and detected changes such as disappearing files produce `PARTIAL` results/lower bounds rather than reporting unscanned areas as zero. Press `i` for scope and diagnostics, or `r` to rescan. Closing the panel cancels subsequent scan work. The inventory does not write files, repair caches, remove stale leases, or run on a background schedule.

**Not covered:** arbitrary project outputs, arbitrary shell-output files, the entire home directory, other plugins' custom paths, or every provider cache. Paths are not guessed from tool-call bodies. Plugins are not loaded or executed to discover locations. The inventory does not decide that files are safe to delete, link artifact deletion to session deletion, follow symlinks, or read special files. Path checks are not an OS sandbox against concurrent malicious replacements; a snapshot is not a deletion safety guarantee.

Artifact-panel keys:

- `Enter`: location details.
- `w`: workspace groups; `a`: all known locations; `c`: current cwd.
- `s`: sessions for the currently selected cwd scope.
- `i`: scope/diagnostics; `r`: refresh; `Esc`: back/close.

The workspace picker supports `/` search, `↑↓` or `j/k`, and paging. Enter opens the selected cwd's session list; it does not automatically resume a session.

## TUI keys

### Session lists and on-demand statistics

| Key | Action |
|---|---|
| `Tab` | Cycle through Sessions / Models / Projects / Tools / Trash / Diagnostics |
| `s` / `m` / `p` / `t` / `b` / `i` | Open the corresponding view; `h` is a compatibility shortcut for Sessions |
| `w` | Pick a cwd and filter sessions exactly, including search and trash |
| `a` | Read-only storage locations associated with the selected session's cwd; cancelling preserves browsing state |
| `↑↓` or `j/k` | Select a session or scroll statistics |
| `PgUp/PgDn` | Page; `g/G` move to the first/last list item |
| `Enter` | **Read-only preview**, without switching sessions or calling a model |
| `R` (uppercase) | Resume the selected session |
| `d` or `Ctrl+D` | Move the selected session to trash; confirmation defaults to Cancel |
| `/` | Edit full-text search; Enter finishes editing, Esc leaves the editor |
| `x` | Toggle search scope between dialogue and all indexed content |
| `c` | Clear an existing cwd filter, or restrict to the current cwd when unfiltered; also affects statistics |
| `1`–`5` | today / 7d / 30d / 90d / all |
| `D` (uppercase) | Enter a custom statistics date range |
| `r` | Refresh the local index; no periodic background scan |
| `u` | Undo the latest deletion, or restore the selected item in Trash |
| `Esc` or `q` | Close the panel |

While editing a search query, `d`, `q`, and similar keys insert ordinary characters rather than triggering actions. Date controls affect statistics, not the session list. Sessions remain ordered by most recent activity; cwd text can also be searched to find other projects.

### Preview

- `Esc` or `q`: return to the list, retaining filters and selection.
- `↑↓`, `j/k`, `PgUp/PgDn`, Space, `g/G`: scroll.
- `x`: show tool arguments/output, thinking, summaries, and other text records.
- `R`: resume; `d` or `Ctrl+D`: delete. In a trash preview, `d` restores instead.

Preview is a **text view of raw history**, including pre-compaction text and other branches. It is not presented as the exact context currently sent to the model. It shows roles, timestamps, and entry IDs. Images are placeholders; base64 payloads are not cached. Use `R` for native images or Pi's full message rendering. Image OCR, semantic retrieval, and Markdown/TeX image rendering are not implemented in the preview.

## Search

- Searches names, IDs, cwd, and all user/assistant text by default, including Chinese substrings.
- Space-separated terms are ANDed; `"a phrase with spaces"` is one term.
- `x` expands the scope to thinking, tool arguments/output, compaction summaries, and other displayable text.
- Matching snippets are shown, and preview opens at a matching message.
- System prompts, opaque thinking signatures, image base64, and arbitrary custom binary data are not indexed. Search is not regex, fuzzy, or vector-based.

## Accounting

- **New sessions:** the session-header creation time falls within the range. Only saved files count; never-persisted empty or temporary sessions are unknown.
- **Active sessions:** persisted messages/usage events attributed to the session fall within the range. Continuing yesterday's session counts as active today, not newly created today.
- Messages, tools, and tokens are bucketed by event time, not the session's creation time.
- Date boundaries use local time and account for DST. The heatmap shows **user-message counts** for up to the last 26 weeks, independently of statistics date controls. Narrow screens show fewer weeks.
- Input, output, cache-read, and cache-write tokens are separate. They are not network upload/download bytes. Reasoning tokens are already included in output and are not added again.
- Recorded usage from assistants, independent usage entries, nested model work in tool results, compaction, and branch summaries is included. Missing usage is flagged. Usage whose model cannot be established stays in the `unattributed/unattributed` bucket rather than being guessed.
- Attribution uses the message's `responseModel` when available, otherwise `model`, together with the provider. Merely selecting a model without calling it is not usage.
- Cost is **the cost recorded in JSONL**, not the provider's invoice. Zero does not necessarily mean free. No prices or provider APIs are queried independently.
- Direct tool calls come from assistant `toolCall` blocks. Nested calls come from `toolResult.nestedCalls` and remain separate. Missing nested-call data in older sessions cannot be reconstructed; incomplete records are flagged. Tool errors are observed failed tool results, not every unfinished or cancelled request.
- Forks/clones form a lineage through `parentSession`. Preserved entry IDs, timestamps, and payload fingerprints deduplicate inherited records, preferring the original session. Deduplication happens across the complete input before cwd filtering so child projects do not inherit the parent's bill. Older entries without IDs cannot be reliably deduplicated. If ancestors are missing, attribution goes to the earliest available copy. All branches in a file contribute to historical usage.
- Trash retains accounting, so moving sessions to trash does not erase yesterday's tokens. Files permanently deleted outside the extension disappear from the index. The extension has no permanent-delete button.
- User counts in session-list rows are the readable records in that file, including inherited history. Aggregate statistics apply lineage deduplication.

## Deletion safety and recovery

1. Confirmation defaults to Cancel and requires an explicit choice.
2. The browser refuses to delete the current session. `/delete` first calls Pi's `newSession`, then performs the move only in the fresh context. A cancelled switch does not delete anything.
3. If a session has changed since its displayed preview, deletion is refused and the browser refreshes for another inspection.
4. After confirmation, inode, modification time, and size are checked again. Changed files and symlinks are refused. An incomplete final record also blocks deletion until the writer finishes.
5. Pi instances running pi-home under the same `PI_CODING_AGENT_DIR` cooperate through process-liveness records. PID reuse can conservatively produce a false active-session indication.
6. **This is not an enforced file lock. Instances without pi-home cannot be reliably detected; close other processes that might be using the session before deleting it.** An uncooperative writer can still recreate the original path after a move.
7. Original JSONL bytes are retained in private trash. The original path and statistics sidecar are persisted first. Restore uses no-overwrite filesystem operations and refuses a conflicting destination. An interrupted restore can be completed if the destination and trash payload are still the same unchanged hardlink. If a trashed payload has changed, automatic restore stops and retains it for manual inspection.
8. Trash and the original must be on the same filesystem. An `EXDEV` move is refused rather than falling back to an unsafe copy-and-delete operation.
9. No scheduled cleanup or automatic permanent deletion.

Default state directory:

```text
~/.pi/agent/pi-home/
├─ config.json
├─ cache.json                 # Rebuildable text index/statistics; mode 0600
├─ active/                    # Cooperative process-liveness records
└─ trash/<uuid>/
   ├─ record.json             # Original path, deletion time, statistics snapshot
   └─ session.jsonl           # Original file
```

`PI_CODING_AGENT_DIR` changes the agent root. Discovery includes the default sessions root, `PI_CODING_AGENT_SESSION_DIR`, the current SessionManager's actual directory, and optional configured roots:

```json
{
  "startup": true,
  "sessionRoots": ["/absolute/other/flat-session-dir"],
  "recursiveSessionRoots": []
}
```

Configuration lives at `<agent-dir>/pi-home/config.json`. Configured roots must be absolute paths. Symlinks are not followed. Session-index discovery follows Pi's storage boundaries:

- Default `sessions/` root: direct `.jsonl` files plus one level of cwd subdirectories. It does not descend further into `subagent-artifacts/`, nested forks, or cache directories.
- Current session directory, environment-variable root, and `sessionRoots`: direct files only.
- To include nested subagent sessions in usage statistics, add their **dedicated session-log root** to `recursiveSessionRoots`. Do not add the whole home directory or project repository for convenience. Recursive discovery still probes the first record, up to 64 KiB, and fully reads only files with valid Pi headers.
- Ordinary worker/reviewer transcript JSONL is quietly skipped and does not count as sessions or tokens. Genuine subagent Pi sessions with valid headers count only when they are within the configured scope.
- Subagent logs outside that scope do not count. The panel is not a bill for every agent on the machine. Diagnostics shows the actual roots and excluded-directory count.

Non-session files are informational. Recognizable corruption, previously indexed sessions that lost their header, and unsupported future formats are warnings. Empty files and incomplete final records are pending rather than automatically considered corrupt; malformed interior records still warn. Unsupported future session versions are neither parsed nor deleted. Versions 1 and 2 are read without migrating or rewriting originals.

The original v0.1.0 cache is rebuilt automatically; no manual deletion is required. Scan issues stay in `i` / `/home diagnostics`, rather than repeatedly appearing in the conversation after refreshes.

**Privacy:** the index contains searchable conversation text, tool output, and thinking. Treat it as sensitive as the original sessions. Cache and state use private permissions. No uploads, network requests, model calls, or provider-credential reads are involved. Do not commit cache/trash to Git or synchronize them publicly.

### Troubleshooting and recovery

- **Broken cache:** close the management UI, remove `cache.json`, and reopen `/home` to rebuild it. Original JSONL is unchanged.
- **Move failure:** a refused move leaves the source intact. If a concurrent-write conflict or recovery-copy location is reported, inspect both the original and recovery paths before retrying; do not blindly overwrite either one.
- **Crash during a trash operation:** a `trash.lock` may remain. Remove it manually only after confirming its recorded process has exited and no other cleanup is running. The extension does not automatically steal locks.
- **Interrupted restore:** an unchanged same-inode hardlink can be finalized by another restore attempt. Duplicate copies of the same session/events count once. If the original path now holds a different session, the old trash usage is still retained.
- **Damaged trash or activity records:** browsing remains available; Diagnostics identifies the problem/recovery location. Deletion or restore depending on unreliable state stays blocked.
- **Terminating another Pi process:** unsaved in-memory content cannot be recovered by this extension. Do not use it to forcibly clean up running sessions.

## Development and validation

```bash
npm ci --ignore-scripts
npm run check       # TypeScript + synthetic unit/integration tests
npm run smoke       # Requires tmux; real Pi fullscreen/regular interaction tests
npm run pack:check
npm run benchmark   # 1,000 synthetic sessions; no access to real history
```

Tests use temporary generated data only. PTY smoke tests isolate HOME, the agent directory, and the subagent temporary root, run with `--offline`, and do not load user resources or access user sessions. Layout fixtures include an unused dummy local-model configuration to avoid the long no-model startup warning; no model requests or real credentials are involved.

See [docs/VALIDATION.md](docs/VALIDATION.md) for validation coverage and the performance baseline, [CHANGELOG.md](CHANGELOG.md) for changes, and [docs/DESIGN.md](docs/DESIGN.md) for design and limitations. Licensed under MIT; upstream attribution and the reference revision are in [NOTICE](NOTICE).
