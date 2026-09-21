import type {
  ImportSessionTranscriptPayload,
  ImportSessionTranscriptResult,
  ListImportableSessionsPayload,
  ListImportableSessionsResult,
  RuntimeEvent,
  Thread,
} from "@/shared/contracts";
import type { SharedSettings } from "@/shared/settings";
import { parseClaudeTranscript } from "./claudeTranscript";
import { parseCodexTranscript } from "./codexTranscript";
import { copySessionIntoHome } from "./copy";
import { resolveImportHomes } from "./homes";
import { replayTranscript } from "./replay";
import { scanImportableSessions } from "./scan";

export interface SessionImportDeps {
  readSharedSettings: () => SharedSettings;
  getThreads: () => readonly Thread[];
  applyRuntimeEvents: (threadId: string, events: readonly RuntimeEvent[]) => void;
  flushRuntimeWrites: (threadId: string) => void;
}

/**
 * Which sessions a thread already covers. Keyed on both the transcript path
 * and the provider session id: the first catches a repeat import, the second
 * catches a session Poracode itself started, which is already a live thread
 * and would otherwise be offered as if it were history.
 */
function importedThreads(threads: readonly Thread[]): {
  byPath: Map<string, string>;
  bySessionId: Map<string, string>;
} {
  const byPath = new Map<string, string>();
  const bySessionId = new Map<string, string>();
  for (const thread of threads) {
    const imported = thread.config.importedFrom;
    if (imported && !byPath.has(imported.path)) byPath.set(imported.path, thread.id);
    const sessionId = thread.sessionRef?.providerSessionId;
    if (sessionId && !bySessionId.has(sessionId)) bySessionId.set(sessionId, thread.id);
  }
  return { byPath, bySessionId };
}

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

export function importSessionTranscript(
  payload: ImportSessionTranscriptPayload,
  deps: SessionImportDeps,
): ImportSessionTranscriptResult {
  const threads = deps.getThreads();
  const currentThread = threads.find((thread) => thread.id === payload.threadId);
  if (!currentThread) {
    throw new Error(`Cannot import into unknown thread ${payload.threadId}.`);
  }
  // The renderer already stamps this thread with the target path and session
  // id before calling in, so it would otherwise match against itself: exclude
  // it before checking whether another thread already holds this session.
  const { byPath, bySessionId } = importedThreads(
    threads.filter((thread) => thread.id !== payload.threadId),
  );
  const sessionId = currentThread.sessionRef?.providerSessionId;
  const duplicateThreadId =
    byPath.get(payload.path) ?? (sessionId ? bySessionId.get(sessionId) : undefined);
  if (duplicateThreadId) {
    throw new Error(
      `Session at ${payload.path} was already imported into thread ${duplicateThreadId}.`,
    );
  }
  // Copy before replaying: a failed copy leaves the thread empty, which the
  // renderer rolls back; a replayed thread whose provider cannot resume it
  // would look imported and silently start over on the first message.
  const path = payload.targetAgentKind
    ? copySessionIntoHome({
        provider: payload.provider,
        path: payload.path,
        homes: resolveImportHomes(deps.readSharedSettings()),
        targetAgentKind: payload.targetAgentKind,
      })
    : payload.path;
  const transcript =
    payload.provider === "codex" ? parseCodexTranscript(path) : parseClaudeTranscript(path);
  const messageCount = replayTranscript({
    threadId: payload.threadId,
    transcript,
    apply: deps.applyRuntimeEvents,
    flush: deps.flushRuntimeWrites,
  });
  return { messageCount, path };
}
