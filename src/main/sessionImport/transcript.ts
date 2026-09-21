/**
 * Shared shape every provider transcript parser produces. Import replays text
 * only: a chat pane of half-mapped tool rows reads worse than a clean
 * conversation, and the resumed provider session still has the real history.
 */

export interface ImportedMessage {
  role: "user" | "assistant";
  text: string;
  /** Timestamp recorded by the provider, when the line carries one. */
  at?: string;
}

export interface ImportedTranscript {
  providerSessionId?: string;
  cwd?: string;
  startedAt?: string;
  messages: ImportedMessage[];
}

/**
 * Claude record types that legitimately carry the session's own metadata
 * (`sessionId`, `cwd`, `timestamp`, `ownerAccountUuid`). Claude has no single
 * meta line — those fields are spread across ordinary conversation records —
 * and every other record on the stream (hook output, file-history snapshots,
 * queue operations) carries a `cwd` and a `timestamp` of its own that are not
 * the session's. The scan and the import-time parser gate on this same set,
 * so they cannot disagree about which folder or session a transcript is.
 */
export const CLAUDE_METADATA_RECORD_TYPES = new Set([
  "user",
  "assistant",
  "bridge-session",
  "summary",
]);

/** One pasted file should not put megabytes into a single chat row. */
export const MAX_IMPORTED_MESSAGE_CHARS = 100_000;
export const TRUNCATION_MARKER = "\n\n[… truncated on import]";

/**
 * Blocks a provider injects into the conversation as a `user` turn: plugin
 * catalogues, environment dumps, AGENTS.md / global instructions, and the
 * handoff preamble Poracode itself appends when a thread changes provider.
 * Codex packs several into a single message, so they are stripped rather than
 * matched whole — whatever the user actually typed survives.
 */
const INJECTED_WRAPPER_RE =
  /<(app-context|recommended_plugins|environment_context|user_instructions|INSTRUCTIONS|system-reminder|task-notification|local-command-stdout|local-command-stderr|command-name|command-message|command-args)>[\s\S]*?<\/\1>/gu;
const AGENTS_HEADING_RE = /^\s*#\s*AGENTS\.md instructions[^\n]*/u;
const HANDOFF_PREAMBLE_RE = /\[provider handoff\][\s\S]*$/u;

/** Strip injected context, leaving only what the user typed (often nothing). */
export function stripInjectedContext(text: string): string {
  return text
    .replace(INJECTED_WRAPPER_RE, "")
    .replace(AGENTS_HEADING_RE, "")
    .replace(HANDOFF_PREAMBLE_RE, "")
    .trim();
}

export function capMessageText(text: string): string {
  if (text.length <= MAX_IMPORTED_MESSAGE_CHARS) return text;
  return text.slice(0, MAX_IMPORTED_MESSAGE_CHARS - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}
