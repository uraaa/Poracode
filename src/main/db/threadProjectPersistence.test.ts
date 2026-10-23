import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project, Thread } from "@/shared/contracts";
import { closeDatabase, initDatabase } from "./connection";
import {
  dbDeleteProject,
  dbGetThread,
  dbGetThreads,
  dbUpsertProject,
  dbUpsertThread,
} from "./projectsThreads";
import { dbApplyThreadRuntimeEvents, dbGetThreadRuntimeItems } from "./runtimeItems";
import { dbSyncAll } from "./sync";

const source: Project = {
  id: "source",
  name: "Source",
  location: { kind: "posix", path: "/projects/source" },
  createdAt: "2026-01-01T00:00:00.000Z",
};
const target: Project = {
  ...source,
  id: "target",
  name: "Target",
  location: { kind: "posix", path: "/projects/target" },
};

function makeThread(id: string): Thread {
  return {
    id,
    projectId: source.id,
    title: `Thread ${id}`,
    agentKind: "test-agent",
    config: { model: "test-model" },
    status: "inactive",
    attention: "none",
    canResumeWithConfig: true,
    sessionRef: { providerSessionId: `session-${id}`, discoveredAt: source.createdAt },
    archived: false,
    done: false,
    starred: true,
    presentationMode: "gui",
    createdAt: source.createdAt,
    updatedAt: source.createdAt,
  };
}

function persistMessage(threadId: string): void {
  dbApplyThreadRuntimeEvents(threadId, [
    {
      type: "item.started",
      threadId,
      itemId: "user-1",
      itemType: "user_message",
      payload: { content: [{ kind: "text", text: "Keep this transcript" }] },
    },
    { type: "item.completed", threadId, itemId: "user-1" },
  ]);
}

const writers = [
  {
    name: "renderer full sync",
    save: (threads: Thread[]) => dbSyncAll([source, target], threads, '{"kind":"home"}'),
  },
  {
    name: "single-row upsert",
    save: (threads: Thread[]) => threads.forEach((thread, index) => dbUpsertThread(thread, index)),
  },
];

describe.each(writers)("thread project persistence through $name", ({ save }) => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "poracode-thread-project-"));
    dbPath = join(dir, "state.sqlite");
    initDatabase(dbPath);
    dbUpsertProject(source, 0);
    dbUpsertProject(target, 1);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  function reopenDatabase(): void {
    closeDatabase();
    initDatabase(dbPath);
  }

  it("keeps multiple moved threads in their new project after reopening an existing database", () => {
    const first = makeThread("first");
    const second = makeThread("second");
    const untouched = makeThread("untouched");
    // Seed the existing row shape produced before project moves were persisted.
    dbUpsertThread(
      { ...first, worktreePath: "/worktrees/first", worktreeBranch: "feature/first" },
      0,
    );
    dbUpsertThread(second, 1);
    dbUpsertThread(untouched, 2);
    persistMessage(first.id);
    const transcript = dbGetThreadRuntimeItems(first.id);
    expect(transcript).toHaveLength(1);
    reopenDatabase();

    const moved = [first, second].map((thread) => ({
      ...thread,
      projectId: target.id,
      updatedAt: "2026-10-23T12:00:00.000Z",
    }));
    save([...moved, untouched]);
    reopenDatabase();

    expect(dbGetThreads()).toEqual([...moved, untouched]);
    expect(dbGetThreadRuntimeItems(first.id)).toEqual(transcript);
  });

  it("persists a move back to the original project after another restart", () => {
    const thread = makeThread("round-trip");
    dbUpsertThread(thread, 0);
    save([{ ...thread, projectId: target.id }]);
    reopenDatabase();
    expect(dbGetThread(thread.id)?.projectId).toBe(target.id);

    save([thread]);
    reopenDatabase();
    expect(dbGetThread(thread.id)).toEqual(thread);
  });

  it("retains a saved move and transcript when the source project is later deleted", () => {
    const thread = makeThread("survivor");
    dbUpsertThread(thread, 0);
    persistMessage(thread.id);
    const transcript = dbGetThreadRuntimeItems(thread.id);
    expect(transcript).toHaveLength(1);
    const moved = { ...thread, projectId: target.id };
    save([moved]);
    dbDeleteProject(source.id);
    reopenDatabase();

    expect(dbGetThread(thread.id)).toEqual(moved);
    expect(dbGetThreadRuntimeItems(thread.id)).toEqual(transcript);
  });
});
