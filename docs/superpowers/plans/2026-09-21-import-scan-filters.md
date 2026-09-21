# Import Scan Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the import panel list every session of the folder it is filtered to, instead of the few that happen to fall inside the newest 200 sessions across all folders.

**Architecture:** The provider, account and folder filters move from the renderer into `scanImportableSessions`, which parses the head of every transcript (237 ms for 937 files) before applying them, so the page limit counts sessions that already matched. The scan also returns the facets it saw, so the dropdowns offer folders and accounts whose sessions all sit outside the page.

**Tech Stack:** TypeScript, Electron main/renderer split, zod IPC contracts, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-21-import-scan-filters-design.md`

## Global Constraints

- Preview reads (512 KB each) happen only for sessions inside the returned page. Never read a preview to decide a filter or a facet.
- Each facet ignores its own filter: the folder list is computed under the provider and account filters only. Otherwise picking a folder leaves that folder as the only option.
- The page limit stays at 200 (`DEFAULT_LIMIT`).
- `listImportableSessions` is a `main-local` procedure; remote clients do not import.
- Verification: `pnpm test`, `pnpm lint`, `pnpm typecheck`.

## File Structure

| File                                                                          | Responsibility                                    |
| ----------------------------------------------------------------------------- | ------------------------------------------------- |
| `src/main/sessionImport/scan.ts` (modify)                                     | Candidate pass, facets, filtered page             |
| `src/main/sessionImport/scan.test.ts` (modify)                                | Facet coverage past the limit                     |
| `src/main/sessionImport/index.ts` (modify)                                    | Pass `agentKind` through, return facets           |
| `src/main/sessionImport/index.test.ts` (modify)                               | Account filter and facet reporting                |
| `src/shared/contracts/sessionImport.ts` (modify)                              | `agentKind` payload field, facet and result types |
| `src/shared/ipc/procedures/sessionImport.ts` (modify)                         | Procedure result type                             |
| `src/renderer/components/sessionImport/importFilters.ts` (modify)             | `reconcileFilters`                                |
| `src/renderer/components/sessionImport/importFilters.test.ts` (modify)        | Its tests                                         |
| `src/renderer/components/sessionImport/ImportSessionsPanel.tsx` (modify)      | Send filters, use returned facets                 |
| `src/renderer/components/sessionImport/ImportSessionsPanel.test.tsx` (modify) | Scan payload and facet-driven dropdown            |

---

### Task 1: The scan reports every folder it saw

**Files:**

- Modify: `src/main/sessionImport/scan.ts`
- Test: `src/main/sessionImport/scan.test.ts`

**Interfaces:**

- Produces: `ImportScanFacets`, `ImportScanResult`, and `scanImportableSessions(input: { homes; cwd?; provider?; agentKind?; limit? }): ImportScanResult`.

- [ ] **Step 1: Write the failing test**

```ts
it("reports every folder it saw, including folders past the page limit", () => {
  const homes: ImportHome[] = [
    {
      provider: "codex",
      agentKind: "codex",
      dir: codexHome([
        { id: "cx-1", cwd: "F:\\busy", prompt: "one" },
        { id: "cx-2", cwd: "F:\\busy", prompt: "two" },
        { id: "cx-3", cwd: "F:\\busy", prompt: "three" },
        { id: "cx-4", cwd: "F:\\quiet", prompt: "four" },
      ]),
    },
  ];

  const result = scanImportableSessions({ homes, limit: 2 });

  expect(result.sessions).toHaveLength(2);
  expect(result.facets.folders).toEqual(expect.arrayContaining(["F:\\busy", "F:\\quiet"]));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run src/main/sessionImport/scan.test.ts`
Expected: FAIL — `result.sessions` is undefined; the function still returns an array.

- [ ] **Step 3: Split the scan into candidates, facets, page**

Replace the single loop with three stages. Candidates first — one head read per file, no previews:

```ts
interface SessionCandidate {
  readonly file: DiscoveredFile;
  readonly head: SessionHead;
  readonly id: string;
  readonly agentKind: string;
}

const candidates: SessionCandidate[] = [];
const seen = new Set<string>();
for (const file of files) {
  const head = readHead(file);
  if (!head) continue;
  if (isMachineSession(head)) continue;
  const id = `${file.home.provider}:${head.providerSessionId}`;
  if (seen.has(id)) continue;
  seen.add(id);
  candidates.push({ file, head, id, agentKind: ownerAgentKind(file, head, input.homes) });
}
```

Then the predicates and the facets:

```ts
const matchesProvider = (c: SessionCandidate) =>
  !input.provider || c.file.home.provider === input.provider;
const matchesAccount = (c: SessionCandidate) => !input.agentKind || c.agentKind === input.agentKind;
const matchesCwd = (c: SessionCandidate) => !input.cwd || samePath(c.head.cwd, input.cwd);

const under = (...predicates: Array<(c: SessionCandidate) => boolean>) =>
  candidates.filter((c) => predicates.every((predicate) => predicate(c)));

const facets: ImportScanFacets = {
  providers: sortedUnique(
    under(matchesAccount, matchesCwd).map((c) => c.file.home.provider),
  ) as ImportedSessionProvider[],
  accounts: sortedUnique(under(matchesProvider, matchesCwd).map((c) => c.agentKind)),
  folders: sortedUnique(
    under(matchesProvider, matchesAccount)
      .map((c) => c.head.cwd)
      .filter((cwd): cwd is string => cwd !== undefined),
  ),
};
```

Then the page, where the previews finally get read:

```ts
const limit = input.limit ?? DEFAULT_LIMIT;
const sessions: ImportableSession[] = [];
for (const candidate of under(matchesProvider, matchesAccount, matchesCwd)) {
  if (sessions.length >= limit) break;
  const { file, head } = candidate;
  const preview = readPreview(file);
  if (preview.length === 0) continue;
  const title = titleFor(file, head.providerSessionId);
  sessions.push({
    id: candidate.id,
    provider: file.home.provider,
    agentKind: candidate.agentKind,
    providerSessionId: head.providerSessionId,
    path: file.path,
    ...(head.cwd ? { cwd: head.cwd } : {}),
    ...(head.startedAt ? { startedAt: head.startedAt } : {}),
    updatedAt: new Date(file.mtimeMs).toISOString(),
    preview,
    ...(title ? { title } : {}),
    cwdExists: head.cwd !== undefined && existsSync(head.cwd),
  });
}
return { sessions, facets };
```

Add the local helper the facets need:

```ts
function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].toSorted((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: "base" }),
  );
}
```

- [ ] **Step 4: Update the existing tests to the new shape**

Every other case in `scan.test.ts` reads the array directly. Destructure instead — `const { sessions } = scanImportableSessions({ homes })` — or append `.sessions` where the call is inline. Nine cases in total.

- [ ] **Step 5: Run the file and watch it pass**

Run: `pnpm exec vitest run src/main/sessionImport/scan.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add src/main/sessionImport/scan.ts src/main/sessionImport/scan.test.ts
git commit -m "feat(import): filter sessions in the scan and report the facets it saw"
```

---

### Task 2: Carry the account filter and the facets through main

**Files:**

- Modify: `src/shared/contracts/sessionImport.ts`, `src/shared/ipc/procedures/sessionImport.ts`, `src/main/sessionImport/index.ts`
- Test: `src/main/sessionImport/index.test.ts`

**Interfaces:**

- Consumes: `ImportScanResult` (Task 1).
- Produces: `ImportSessionFacets`, `ListImportableSessionsResult`, and `agentKind` on `listImportableSessionsPayloadSchema`.

- [ ] **Step 1: Write the failing test**

```ts
it("filters by account and still reports the accounts it saw", () => {
  const { dir } = codexHomeWith("cx-1", "F:\\repo", "fix the bug");
  const deps = {
    readSharedSettings: () => settingsWithHome(dir),
    getThreads: () => [],
    applyRuntimeEvents: vi.fn<(threadId: string, events: readonly RuntimeEvent[]) => void>(),
    flushRuntimeWrites: vi.fn<(threadId: string) => void>(),
  };

  const mine = listImportableSessions({ agentKind: "codex:work" }, deps);
  expect(mine.sessions.map((session) => session.providerSessionId)).toEqual(["cx-1"]);

  const other = listImportableSessions({ agentKind: "codex:nobody" }, deps);
  expect(other.sessions).toEqual([]);
  // The account facet ignores the account filter, or picking one account
  // would leave the dropdown holding only that account.
  expect(other.facets.accounts).toContain("codex:work");
});
```

`settingsWithHome` registers the temp directory as the profile `work`, so the
session's kind is `codex:work`, not `codex`.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run src/main/sessionImport/index.test.ts`
Expected: FAIL — `sessions.map is not a function`, because `listImportableSessions` still returns an array.

- [ ] **Step 3: Extend the contract**

```ts
export const listImportableSessionsPayloadSchema = z.object({
  cwd: z.string().min(1).optional(),
  provider: importedSessionProviderSchema.optional(),
  /** Keep only sessions belonging to this agent kind (account or profile). */
  agentKind: z.string().min(1).optional(),
});

export interface ImportSessionFacets {
  providers: ImportedSessionProvider[];
  accounts: string[];
  folders: string[];
}

export interface ListImportableSessionsResult {
  sessions: ImportableSession[];
  facets: ImportSessionFacets;
}
```

In `src/shared/ipc/procedures/sessionImport.ts`, swap the result type of
`listImportableSessions` from `ImportableSession[]` to
`ListImportableSessionsResult`.

- [ ] **Step 4: Pass the filter through and return the facets**

```ts
export function listImportableSessions(
  payload: ListImportableSessionsPayload,
  deps: SessionImportDeps,
): ListImportableSessionsResult {
  const homes = resolveImportHomes(deps.readSharedSettings());
  const { sessions, facets } = scanImportableSessions({
    homes,
    ...(payload.cwd ? { cwd: payload.cwd } : {}),
    ...(payload.provider ? { provider: payload.provider } : {}),
    ...(payload.agentKind ? { agentKind: payload.agentKind } : {}),
  });
  const { byPath, bySessionId } = importedThreads(deps.getThreads());
  return {
    sessions: sessions.map((session) => {
      const threadId = byPath.get(session.path) ?? bySessionId.get(session.providerSessionId);
      return threadId ? { ...session, importedThreadId: threadId } : session;
    }),
    facets,
  };
}
```

Update the two existing cases in `index.test.ts` to `const { sessions } = ...`.

- [ ] **Step 5: Run the checks**

Run: `pnpm exec vitest run src/main/sessionImport && pnpm typecheck`
Expected: PASS. Typecheck flags the IPC handler if the procedure's result type was missed.

- [ ] **Step 6: Commit**

```bash
git add src/shared/contracts/sessionImport.ts src/shared/ipc/procedures/sessionImport.ts \
        src/main/sessionImport/index.ts src/main/sessionImport/index.test.ts
git commit -m "feat(import): carry the account filter and facets across IPC"
```

---

### Task 3: The panel scans for what it is filtered to

**Files:**

- Modify: `src/renderer/components/sessionImport/importFilters.ts`, `ImportSessionsPanel.tsx`
- Test: `importFilters.test.ts`, `ImportSessionsPanel.test.tsx`

**Interfaces:**

- Consumes: `ListImportableSessionsResult`, `ImportSessionFacets` (Task 2).
- Produces: `reconcileFilters(filters: ImportFilters, facets: ImportSessionFacets): ImportFilters`.

- [ ] **Step 1: Write the failing tests**

In `importFilters.test.ts`:

```ts
describe("reconcileFilters", () => {
  const facets = {
    providers: ["claude", "codex"] as ImportedSessionProvider[],
    accounts: ["claude"],
    folders: ["F:\\a"],
  };

  it("drops a selection the scan no longer offers", () => {
    expect(
      reconcileFilters({ ...EMPTY_FILTERS, account: "codex:work", folder: "F:\\a" }, facets),
    ).toMatchObject({ account: ALL, folder: "F:\\a" });
  });

  it("leaves the query and the valid selections alone", () => {
    expect(
      reconcileFilters({ provider: "codex", account: "claude", folder: ALL, query: "bet" }, facets),
    ).toEqual({ provider: "codex", account: "claude", folder: ALL, query: "bet" });
  });
});
```

In `ImportSessionsPanel.test.tsx`:

```tsx
it("scans for the folder it is filtered to, not for everything", async () => {
  render(<ImportSessionsPanel initialFolder={"F:\\repo"} initialProjectId="p1" />);

  await screen.findByText("fix the race condition");
  await vi.waitFor(() =>
    expect(listImportableSessionsMock).toHaveBeenCalledWith({ cwd: "F:\\repo" }),
  );
});

it("offers a folder the scan saw even when no session on this page is in it", async () => {
  listImportableSessionsMock.mockResolvedValue({
    sessions: [session()],
    facets: { providers: ["codex"], accounts: ["codex"], folders: ["F:\\repo", "F:\\quiet"] },
  });
  render(<ImportSessionsPanel initialProjectId="p1" />);

  await screen.findByText("fix the race condition");
  expect(
    within(screen.getByLabelText("Project")).getByRole("option", { name: "quiet" }),
  ).toBeInTheDocument();
});
```

The existing panel cases return plain arrays. Keep them working by wrapping in
the bridge mock rather than editing each case:

```tsx
function found(sessions: ImportableSession[]) {
  return {
    sessions,
    facets: {
      providers: [...new Set(sessions.map((s) => s.provider))],
      accounts: [...new Set(sessions.map((s) => s.agentKind))],
      folders: [...new Set(sessions.flatMap((s) => (s.cwd ? [s.cwd] : [])))],
    },
  };
}

vi.mock("@/renderer/bridge", () => ({
  isWindows: () => true,
  readBridge: () => ({
    listImportableSessions: async (payload: unknown) => {
      const value = await listImportableSessionsMock(payload);
      return Array.isArray(value) ? found(value) : value;
    },
    importSessionTranscript: importSessionTranscriptMock,
  }),
}));
```

Widen the mock's type to `vi.fn<(payload: unknown) => Promise<unknown>>()` so a
case can return the full result, and drop the now-wrong
`expect(listImportableSessionsMock).toHaveBeenCalledWith({})` assertion from the
first case.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm exec vitest run src/renderer/components/sessionImport`
Expected: FAIL — `reconcileFilters is not a function`, and the panel cases fail
to find their text because the panel still treats the result as an array.

- [ ] **Step 3: Add `reconcileFilters`**

```ts
export function reconcileFilters(
  filters: ImportFilters,
  facets: ImportSessionFacets,
): ImportFilters {
  const keep = <T extends string>(value: T, valid: readonly string[]): T | typeof ALL =>
    value === ALL || valid.includes(value) ? value : ALL;
  return {
    ...filters,
    provider: keep(filters.provider, facets.providers),
    account: keep(filters.account, facets.accounts),
    folder: keep(filters.folder, facets.folders),
  };
}
```

- [ ] **Step 4: Send the filters and consume the facets**

In `ImportSessionsPanel.tsx`, hold the facets in state and build the payload
from the filters:

```tsx
const [facets, setFacets] = useState<ImportSessionFacets>({
  providers: [],
  accounts: [],
  folders: [],
});

const load = useCallback(
  () =>
    readBridge().listImportableSessions({
      ...(filters.provider === ALL ? {} : { provider: filters.provider }),
      ...(filters.account === ALL ? {} : { agentKind: filters.account }),
      ...(filters.folder === ALL ? {} : { cwd: filters.folder }),
    }),
  [filters.account, filters.folder, filters.provider],
);
```

In the effect's success branch:

```tsx
setSessions(found.sessions);
setFacets(found.facets);
setFilters((current) => reconcileFilters(current, found.facets));
```

Drop the `importFacetOptions` memo and make `select` a plain patch —
`setFilters((current) => ({ ...current, ...patch }))` — since the scan now owns
validity. `applyImportFilters` stays: it is the search text, plus a harmless
re-check while a scan for new filters is in flight.

- [ ] **Step 5: Run the whole check**

Run: `pnpm exec vitest run src/renderer/components/sessionImport && pnpm lint && pnpm typecheck`
Expected: PASS, 24 renderer tests.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/sessionImport
git commit -m "fix(import): list every session of the folder the panel is filtered to"
```

---

### Task 4: Confirm it on the real store

**Files:** none — evidence, not code.

- [ ] **Step 1: Count what the folder actually holds**

```bash
node "$TEMP/scanprobe.mjs"
```

Expected: the non-machine session count for the folder, and how many of them
fall past rank 200 in the global recency order. On the reviewed machine: 26 and 18.

- [ ] **Step 2: Open the panel for that project**

Expected: the list holds the sessions that used to be missing — verify by name
("проанализируй PR 33"). Expected count on the reviewed machine: 25, the
twenty-sixth held back by the empty-preview defect listed in the spec's
out-of-scope section.

- [ ] **Step 3: Switch the folder filter**

Expected: every folder with sessions is offered, not only folders represented on
the current page; switching re-scans and the list changes accordingly.

- [ ] **Step 4: Record the numbers in the pull request**

No commit.

## Notes for the implementer

- `input.cwd` already filtered before the limit. The bug was that nothing passed
  it, so do not "fix" the loop — fix who calls it.
- Facets are computed before the page is cut, and each ignores its own filter.
  Getting this backwards makes a dropdown collapse to the value just chosen.
- The panel reload is triggered by the `load` callback's dependencies. Keep them
  the three filter fields, not the whole `filters` object, or typing in the
  search box re-scans on every keystroke.
