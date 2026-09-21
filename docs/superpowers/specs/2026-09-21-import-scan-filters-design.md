# Filter importable sessions in the scan, not after its page limit

**Date:** 2026-09-21
**Status:** Implemented, pending review

## Problem

The import panel shows a fraction of a project's sessions. Measured on a real
store: 937 Codex rollout files, 26 of them non-machine sessions recorded against
`F:\STORM_PROJECTS\_HALLIANCE\halliance-platform`, and the panel listed 6.

`scanImportableSessions` sorted every session of every folder by modification
time, took the newest 200 and stopped. The folder, account and provider filters
lived in the renderer (`importFilters.ts`) and ran over that page. Sorted by
recency across all folders, the project's sessions sat at ranks 1, 19, 41, 42,
90, 156, 158, 184, then 264, 268, 549 and older — eighteen of twenty-six fell
past the cut and were unreachable however the user filtered.

The folder dropdown had the same defect for the same reason: it was built from
the page, so a project whose sessions are all older than the newest 200 could
not even be selected.

## Decisions

- **The scan applies the dropdown filters.** Provider, account and folder are
  passed to the main process; the page limit then counts sessions that already
  survived them. The `cwd` parameter existed and behaved correctly — nothing
  passed it.
- **Heads are parsed for every file, unconditionally.** Measured: 937 files,
  10 ms to walk, 9 ms to stat and sort, 237 ms to read and parse every head
  (116 MB). The page limit exists to bound _preview_ reads — 512 KB per session
  — not head reads, so parsing all heads costs a quarter second and makes the
  filters honest.
- **The scan reports the facets it saw.** A folder or account is offered
  whenever it has any session, page limit or not. Each facet ignores its own
  filter, so picking a folder never empties the folder list.
- **Previews stay lazy.** They are read only for sessions that survived every
  filter and fall inside the page, which is what keeps the scan fast.
- **The renderer re-scans when a dropdown changes.** The search text keeps
  filtering client-side over what came back.

## Design

### Scan

`scanImportableSessions` gains `agentKind` and returns a result instead of an
array:

```ts
export interface ImportScanFacets {
  readonly providers: ImportedSessionProvider[];
  readonly accounts: string[];
  readonly folders: string[];
}
export interface ImportScanResult {
  readonly sessions: ImportableSession[];
  readonly facets: ImportScanFacets;
}
```

The pass runs in three stages:

1. **Candidates.** Walk every home, stat and sort by recency, read each head,
   drop machine sessions (`thread_source: subagent`, `source: exec`,
   `originator: codex_exec`) and duplicates of a session id already seen.
   Attribution (`ownerAgentKind`) happens here, since the account filter needs it.
2. **Facets.** For each dimension, the distinct values of the candidates that
   match the _other_ two filters.
3. **Page.** Filter by all three, take `limit` (200), and only then read the
   preview and title of each survivor.

### Contract and IPC

`listImportableSessionsPayloadSchema` gains an optional `agentKind`. The
procedure result becomes `ListImportableSessionsResult { sessions, facets }`.
`ImportSessionFacets` lives in `src/shared/contracts/sessionImport.ts` so both
sides name the same shape.

### Renderer

`ImportSessionsPanel` builds the scan payload from its filters and reloads when
any of them changes. Dropdown options come from the returned facets.

`importFilters.ts` loses `importFacetOptions` and `selectImportFilter` as the
panel's source of truth and gains:

```ts
export function reconcileFilters(
  filters: ImportFilters,
  facets: ImportSessionFacets,
): ImportFilters;
```

which drops a selection the latest scan no longer offers. Because each facet
ignores its own filter, a selection that appears there is still reachable;
resetting only ever widens, so the reload it triggers settles in one round.

### Testing

Against real fixtures on disk:

- The scan reports a folder that has no session inside the page limit.
- `listImportableSessions` honours the account filter and still reports the
  accounts it saw, so the dropdown cannot narrow itself to the current pick.
- The panel scans for the folder it is filtered to rather than for everything.
- The panel offers a folder the scan reported even when no session on the
  current page is in it.
- `reconcileFilters` drops an unreachable selection and leaves the search text
  and the valid selections alone.

## Result on real data

Of the 26 non-machine sessions in that folder, 25 are now listed — including
"проанализируй PR 33". The twenty-sixth is dropped by a separate, pre-existing
defect (see below).

## Out of scope

Known defects this change does not address, each measured during the review:

- A session whose first 512 KB contain no user text is silently omitted rather
  than listed under its title.
- The 200-session page limit is invisible in the UI once "All folders" is
  selected.
- The search text only matches the returned page.
- Claude transcripts are replayed without stripping injected blocks.
- `cwdExists` calls `existsSync` per session with no cache.
- `importSessions` does not re-check `importedThreadId` before creating a thread.
