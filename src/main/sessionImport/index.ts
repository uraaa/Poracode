import type {
  ImportSessionTranscriptPayload,
  ImportSessionTranscriptResult,
  ImportableSession,
  ListImportableSessionsPayload,
  RuntimeEvent,
  Thread,
} from "@/shared/contracts";
import type { SharedSettings } from "@/shared/settings";
import { parseClaudeTranscript } from "./claudeTranscript";
import { parseCodexTranscript } from "./codexTranscript";
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
): ImportableSession[] {
  const homes = resolveImportHomes(deps.readSharedSettings());
  const sessions = scanImportableSessions({
    homes,
    ...(payload.cwd ? { cwd: payload.cwd } : {}),
    ...(payload.provider ? { provider: payload.provider } : {}),
  });
  const { byPath, bySessionId } = importedThreads(deps.getThreads());
  return sessions.map((session) => {
    const threadId = byPath.get(session.path) ?? bySessionId.get(session.providerSessionId);
    return threadId ? { ...session, importedThreadId: threadId } : session;
  });
}

export function importSessionTranscript(
  payload: ImportSessionTranscriptPayload,
  deps: SessionImportDeps,
): ImportSessionTranscriptResult {
  const exists = deps.getThreads().some((thread) => thread.id === payload.threadId);
  if (!exists) {
    throw new Error(`Cannot import into unknown thread ${payload.threadId}.`);
  }
  const transcript =
    payload.provider === "codex"
      ? parseCodexTranscript(payload.path)
      : parseClaudeTranscript(payload.path);
  const messageCount = replayTranscript({
    threadId: payload.threadId,
    transcript,
    apply: deps.applyRuntimeEvents,
    flush: deps.flushRuntimeWrites,
  });
  return { messageCount };
}
