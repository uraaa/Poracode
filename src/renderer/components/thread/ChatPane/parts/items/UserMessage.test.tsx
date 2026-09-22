import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppProvider } from "@/renderer/components/ui/provider";
import type { RuntimeChatItem } from "@/renderer/state/slices/runtimeEventSlice";
import { UserMessage } from "./UserMessage";

function userItem(payload: Record<string, unknown>): RuntimeChatItem {
  return {
    id: "user_1",
    type: "user_message",
    state: "completed",
    payload,
    streams: {},
  } as RuntimeChatItem;
}

function renderMessage(payload: Record<string, unknown>) {
  const { container } = render(
    <AppProvider>
      <UserMessage threadId="thread-1" item={userItem(payload)} checkpointRevert={null} />
    </AppProvider>,
  );
  return container.querySelector<HTMLElement>("[data-user-message='true']");
}

describe("UserMessage", () => {
  it("marks a message the model has not received yet", () => {
    const surface = renderMessage({
      content: [{ kind: "text", text: "queued while working" }],
      pendingDelivery: true,
    });

    expect(surface?.dataset.pendingDelivery).toBe("true");
  });

  it("leaves a delivered message unmarked", () => {
    const surface = renderMessage({ content: [{ kind: "text", text: "already delivered" }] });

    expect(surface?.dataset.pendingDelivery).toBeUndefined();
  });
});
