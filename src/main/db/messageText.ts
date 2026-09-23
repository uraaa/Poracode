import { assistantDisplayText } from "@/shared/assistantMessageText";
import type { PersistedRuntimeItem } from "./runtimeItems";

export interface ExtractedMessage {
  role: "user" | "assistant";
  text: string;
}

type ItemForExtraction = Pick<PersistedRuntimeItem, "type" | "state" | "streams"> & {
  payload?: unknown;
};

function userText(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const content = (payload as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const { kind, text } = block as { kind?: unknown; text?: unknown };
    if (kind === "text" && typeof text === "string" && text.length > 0) parts.push(text);
  }
  return parts.join("\n");
}

/**
 * Plain text of a message item, or null when there is nothing to index —
 * either the type is not a message, or the message carries no text. Keeping
 * both cases as null lets every caller skip on a single check.
 */
export function extractMessageText(item: ItemForExtraction): ExtractedMessage | null {
  if (item.type === "user_message") {
    const text = userText(item.payload);
    return text.length > 0 ? { role: "user", text } : null;
  }
  if (item.type === "assistant_message") {
    // Through the shared helper, so the index holds exactly the text the
    // transcript shows: an authoritative payload overrides the stream, and an
    // authoritative empty payload suppresses the message everywhere at once.
    //
    // `item.streams` only ever holds the head of the stream (HEAD_CHARS,
    // runtimeStreamCap.ts — 256,000 characters); text past the head lives in
    // `thread_runtime_item_stream_chunks` and is never read here. A very long
    // answer is therefore only searchable up to its head — undocumented
    // elsewhere, so noted at the point it takes effect.
    const text = assistantDisplayText({
      state: item.state,
      payload: item.payload,
      streams: item.streams ?? {},
    });
    return text.length > 0 ? { role: "assistant", text } : null;
  }
  return null;
}
