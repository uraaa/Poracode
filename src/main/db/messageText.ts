import type { PersistedRuntimeItem } from "./runtimeItems";

export interface ExtractedMessage {
  role: "user" | "assistant";
  text: string;
}

type ItemForExtraction = Pick<PersistedRuntimeItem, "type" | "streams"> & { payload?: unknown };

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
    const text = item.streams?.assistant_text ?? "";
    return text.length > 0 ? { role: "assistant", text } : null;
  }
  return null;
}
