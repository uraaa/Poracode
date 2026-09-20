import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ImportableSession, ImportedSessionProvider } from "@/shared/contracts";
import { parseClaudeTranscript, readClaudeSessionHead } from "./claudeTranscript";
import { parseCodexTranscript, readCodexSessionHead } from "./codexTranscript";
import type { ImportHome } from "./homes";
import type { ImportedTranscript } from "./transcript";

/** Preview lines are a list affordance, not a document. */
const PREVIEW_MAX_CHARS = 200;

function walkFiles(root: string, accept: (name: string) => boolean): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && accept(entry.name)) found.push(path);
    }
  };
  walk(root);
  return found;
}

function samePath(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const normalize = (value: string) => value.replace(/[\\/]+$/u, "").replace(/\\/gu, "/");
  return (
    normalize(left).localeCompare(normalize(right), undefined, { sensitivity: "accent" }) === 0
  );
}

function previewOf(transcript: ImportedTranscript): string {
  const first = transcript.messages.find((message) => message.role === "user");
  const text = (first?.text ?? "").replace(/\s+/gu, " ").trim();
  return text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS)}…` : text;
}

function updatedAtOf(path: string): string | undefined {
  try {
    return new Date(statSync(path).mtimeMs).toISOString();
  } catch {
    return undefined;
  }
}

function sessionFilesFor(home: ImportHome): string[] {
  return home.provider === "codex"
    ? walkFiles(
        join(home.dir, "sessions"),
        (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"),
      )
    : walkFiles(join(home.dir, "projects"), (name) => name.endsWith(".jsonl"));
}

function describeSession(home: ImportHome, path: string): ImportableSession | undefined {
  const head = home.provider === "codex" ? readCodexSessionHead(path) : readClaudeSessionHead(path);
  if (!head?.providerSessionId) return undefined;
  let transcript: ImportedTranscript;
  try {
    transcript =
      home.provider === "codex" ? parseCodexTranscript(path) : parseClaudeTranscript(path);
  } catch {
    return undefined;
  }
  if (transcript.messages.length === 0) return undefined;
  const cwd = transcript.cwd ?? head.cwd;
  const startedAt = transcript.startedAt ?? head.startedAt;
  const updatedAt = updatedAtOf(path);
  return {
    id: `${home.provider}:${head.providerSessionId}`,
    provider: home.provider,
    agentKind: home.agentKind,
    providerSessionId: head.providerSessionId,
    path,
    ...(cwd ? { cwd } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    messageCount: transcript.messages.length,
    preview: previewOf(transcript),
    cwdExists: cwd !== undefined && existsSync(cwd),
  };
}

/**
 * Discover importable transcripts across the given homes. Never throws: an
 * unreadable file or a missing home is skipped so one bad session cannot hide
 * the rest of a user's history.
 */
export function scanImportableSessions(input: {
  homes: readonly ImportHome[];
  cwd?: string;
  provider?: ImportedSessionProvider;
}): ImportableSession[] {
  const byId = new Map<string, ImportableSession>();
  for (const home of input.homes) {
    if (input.provider && home.provider !== input.provider) continue;
    for (const path of sessionFilesFor(home)) {
      const session = describeSession(home, path);
      if (!session) continue;
      if (input.cwd && !samePath(session.cwd, input.cwd)) continue;
      if (!byId.has(session.id)) byId.set(session.id, session);
    }
  }
  return [...byId.values()].sort((left, right) =>
    (right.updatedAt ?? right.startedAt ?? "").localeCompare(
      left.updatedAt ?? left.startedAt ?? "",
    ),
  );
}
