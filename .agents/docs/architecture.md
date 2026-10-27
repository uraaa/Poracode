# Architecture & Code Organization

## Layers

- `src/main/`: Electron shell (`main.ts`), context-isolated preload bridge (`preload.ts`), SQLite database (`db.ts`, `db.schema.ts` via Drizzle ORM + better-sqlite3).
- `src/supervisor/`: Forked Node process owning all agent PTY sessions, git operations, terminal log persistence, agent status caching, and commit message generation. Entry point: `index.ts` (IPC dispatcher that trusts pre-validated payloads — Zod validation runs caller-side in the main process before dispatch, not in the supervisor).
- `src/renderer/`: React 19 + HeroUI v3 + xterm.js. Zustand stores for state; a couple persist to SQLite via the preload bridge (`appStore`, `threadTodoDockStore`), several persist to `localStorage`, and many are ephemeral — see the State Management table for the per-store breakdown.
- `src/shared/`: Zod schemas, TypeScript types, IPC contracts (`ipc.ts`), and pure helpers (ANSI stripping, WSL path utilities, worktree path computation, theme resolution, agent status filtering).

## IPC Architecture

The main process forks the supervisor as a child process. Communication is UUID-keyed request/reply over `process.send()` + `process.on("message")`. The supervisor also emits fire-and-forget events (thread output, state changes, agent statuses) that the main process forwards to the renderer via `webContents.send` (received in the renderer through `ipcRenderer.on`).

The preload bridge (`window.poracode`) wraps all IPC into typed async methods defined by the `PoracodeBridge` type, declared in `src/shared/ipc/bridge.ts` and re-exported via the `src/shared/ipc.ts` barrel.

## State Management

Zustand stores in `src/renderer/state/`. Each cross-cutting UI domain owns its own store — do not broaden an existing store to cover a new concern.

| Store                       | Persisted | Purpose                                                                                               |
| --------------------------- | --------- | ----------------------------------------------------------------------------------------------------- |
| `appStore`                  | SQLite    | Projects, threads, panes, agent statuses, pending server requests, draft config                       |
| `gitStore`                  | Local     | Per-project/per-worktree git status, PR data, branch lists, source info (snapshot restored on launch) |
| `devTerminalStore`          | No        | Shell session tabs, active project/worktree, per-tab activity tracking                                |
| `panelStore`                | Local     | Settings/project-settings open state, git+files side-panel context, right-panel tab                   |
| `fileEditorStore`           | No        | Editor tabs, active path, preview tab, dirty buffers                                                  |
| `projectTreeStore`          | No        | File tree expanded/loading paths, directory entries cache, drop target, committed search              |
| `sharedSettingsStore`       | Local     | Theme mode, commit/title/conflict generation provider/model/effort                                    |
| `agentStatusesStore`        | Local     | Per-environment (Windows/WSL) agent install + auth status                                             |
| `updateStore`               | No        | Auto-update phase, version, download progress                                                         |
| `worktreeDeleteStore`       | No        | Ephemeral UI state for worktree delete confirmation                                                   |
| `browserPanelStore`         | No        | Browser-MCP panel state + pending picker attachments                                                  |
| `loginTerminalStore`        | No        | One-shot login terminal session (TUI auth overlay)                                                    |
| `projectRootNamesStore`     | No        | Cached top-level entry names per project root (mention/path resolution)                               |
| `providerUsageStore`        | No        | Per-provider usage snapshots streamed from the supervisor                                             |
| `pullFromSourceDialogStore` | No        | Ephemeral state for the "pull from source branch" dialog                                              |
| `sidebarOverlayStore`       | Local     | Sidebar overlay/collapse mode + transition suppression                                                |
| `sidebarUiStore`            | Local     | Collapsed projects/worktrees, thread-list limits, inline rename state                                 |
| `threadSubAgentDockStore`   | No        | Per-thread dismissed sub-agent dock items                                                             |
| `threadTodoDockStore`       | SQLite    | Thread todo dock placement + collapsed state                                                          |
| `usageLoginStateStore`      | No        | Per-provider "login secret stored" flags from the main process                                        |
| `workflowRunStore`          | No        | Shared poller for the workflow manifest (sub-agent counters)                                          |

Components connect to stores directly — avoid prop drilling. Subscriptions must be **narrow and primitive-returning** (see `editing-rules.md` → Store Subscriptions & Render Isolation). Per-entity boolean/string hooks (`useIsTabActive(path)`, `usePrState(key)`, `useIsPathExpanded(path)`) are the default pattern; whole-object subscriptions are banned on hot paths.

Companion selector modules (`fileEditorSelectors.ts`, `gitSelectors.ts`, `hooks/uiSelectors.ts`) house derivations keyed on store-array identity via the `createArrayKeyedMap` helper in `state/derivations.ts` — first caller builds O(N), subsequent callers are O(1) until the store replaces the array (the underlying `WeakMap` releases memory automatically).

## Build Pipeline

| Target            | Tool              | Entry                                         | Output                                  | Format                                                                     |
| ----------------- | ----------------- | --------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------- |
| Renderer          | Vite 8 (Rolldown) | `src/renderer/main.tsx`                       | `dist/renderer/`                        | ESM, manual chunks (xterm, git-diff, monaco, shiki, ui, framework, vendor) |
| Main process      | tsdown            | `src/main/main.ts`                            | `dist/main/main.cjs`                    | CJS, Node 24                                                               |
| Preload           | tsdown            | `src/main/preload.ts`                         | `dist/main/preload.cjs`                 | CJS, Node 24                                                               |
| Supervisor        | tsdown            | `src/supervisor/index.ts`                     | `dist/main/supervisor.cjs`              | CJS, Node 24                                                               |
| Repository worker | tsdown            | `src/supervisor/repositoryCommands/worker.ts` | `dist/main/repositoryCommandWorker.cjs` | CJS, Node 24                                                               |
| Distribution      | electron-builder  | —                                             | `release/`                              | NSIS (Win), AppImage+deb (Linux), DMG (macOS)                              |

Native modules (`node-pty`, `better-sqlite3`, `electron`) are excluded from bundling and unpacked from ASAR.

## Database

SQLite via Drizzle ORM (`src/main/db.ts`, `db.schema.ts`). Drizzle tables: `projects`, `threads`, `appState`, `projectNotes`, `threadRuntimeItems`, `threadContextUsage`, `threadCompletedTurns`. Plus `usage_events`, created via raw `CREATE TABLE` DDL in `db.ts` rather than the Drizzle schema. The renderer reads/writes through preload bridge methods (`dbGetProjects`, `dbUpsertThread`, `dbSyncAll`, etc.). Zustand persistence uses a custom `dbStorage` backend.

## Git Integration

`src/supervisor/git.ts` routes native git commands through `repositoryCommands/client.ts`. Persistent worker threads own executable resolution, command preparation and `execFile`, including the synchronous Windows process-creation cost. Native GitHub CLI commands use the same transport. WSL projects retain their bridge client. Operations: status, diff (single + batch), stage/unstage/revert, commit, branch listing, fetch, worktree CRUD.

`repositoryCommands/scheduling.ts` limits native local polling commands to two in flight globally, with a separate single-command lane for background fetch and GitHub requests. Callers explicitly opt into polling with the optional `background` hint; omitted hints remain interactive, including MCP and remote clients. Identical queued/running background reads share work within a repository read epoch; mutations invalidate that epoch before and after execution. Interactive commands use an independent worker and bypass polling limits. Thread RPCs never enter these queues. Worker failures reject pending commands without replaying them; only new commands start a replacement worker. Shutdown stops producers, then drains accepted interactive/network commands with a thirty-second supervisor exit deadline.

Renderer refreshes watch open panes, visible panels/terminals and active experiments rather than every sidebar worktree. Watcher notifications coalesce per project until 250 ms of quiet and at least two seconds since the previous cycle. A thirty-second generation watchdog releases hung project work and prevents its late results from changing state. Periodic fetch runs independently of local status cycles. Polling uses a single porcelain status command per worktree; full diff counts load only for the visible Git review or explicit refresh. Config-derived remote metadata is shared across linked worktrees with config fingerprints, mutation invalidation and a thirty-second TTL. Git watchers discard object, reflog and checkpoint-ref churn. Bulk PR rows include authorship metadata and replace branch lookups only for returned branches; the capped list cannot establish that an absent branch has no PR.

The worker and supervisor are built together in one tsdown entry group, so the supervisor SSH manifest includes the worker and shared chunks. The manifest format remains compatible; its content hash changes when these artifacts change. Their private worker protocol is version 2: ambient environment is transferred at worker initialization or executable-cache invalidation, and shutdown supports draining accepted commands. There is no persisted or independently updated protocol copy. Polling hints are additive optional IPC fields; older callers retain interactive behavior.

Commit message generation (`src/supervisor/commitMessageGenerator.ts`) spawns a one-shot agent CLI call with a conventional-commits prompt piped to stdin. Falls back across providers if the preferred one fails.

Worktree paths are computed within a centralized directory (`~/.poracode/worktrees/<repo-id>/<branch-id>`) via `src/supervisor/git.ts` and `src/shared/worktree.ts`.
