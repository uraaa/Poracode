import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, SendThreadInputPayload, Thread, ThreadStatus } from "@/shared/contracts";
import { AppProvider } from "@/renderer/components/ui/provider";
import { performThreadInputSubmit } from "@/renderer/actions/threadRuntimeActions";
import { useAppStore } from "@/renderer/state/appStore";
import type { RuntimeChatItem } from "@/renderer/state/slices/runtimeEventSlice";
import { UserMessage } from "./UserMessage";

// The submit path fires product analytics, which reaches for a preload bridge
// that does not exist under jsdom.
vi.mock("@/renderer/analytics/posthog", () => ({
  captureThreadPromptSubmitted: vi.fn<(...args: unknown[]) => void>(),
  threadProductProperties: () => ({}),
}));

function userItem(payload: Record<string, unknown>): RuntimeChatItem {
  return {
    id: "user_1",
    type: "user_message",
    state: "completed",
    payload,
    streams: {},
  } as RuntimeChatItem;
}

function renderItem(item: RuntimeChatItem) {
  const { container } = render(
    <AppProvider>
      <UserMessage threadId="thread-1" item={item} checkpointRevert={null} />
    </AppProvider>,
  );
  return container.querySelector<HTMLElement>("[data-user-message='true']");
}

function renderMessage(payload: Record<string, unknown>) {
  return renderItem(userItem(payload));
}

describe("UserMessage", () => {
  it("marks a message the model has not received yet", () => {
    const surface = renderMessage({
      content: [{ kind: "text", text: "queued while working" }],
      pendingDelivery: true,
    });

    expect(surface?.dataset.pendingDelivery).toBe("true");
    // The dim alone says nothing to a screen reader.
    expect(surface?.title).toBe("Not handed to the agent yet");
  });

  it("leaves a delivered message unmarked", () => {
    const surface = renderMessage({ content: [{ kind: "text", text: "already delivered" }] });

    expect(surface?.dataset.pendingDelivery).toBeUndefined();
    expect(surface?.title).toBe("");
  });
});

const project: Project = {
  id: "project-1",
  name: "Repo",
  location: { kind: "posix", path: "/repo" },
  scripts: { actions: [] },
  createdAt: "2026-01-01T00:00:00.000Z",
};

function guiThread(status: ThreadStatus): Thread {
  return {
    id: "thread-1",
    projectId: project.id,
    title: "Thread",
    agentKind: "codex",
    config: { model: "codex/model" },
    status,
    attention: status === "working" ? "working" : "none",
    canResumeWithConfig: true,
    archived: false,
    done: false,
    starred: false,
    presentationMode: "gui",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as Thread;
}

/**
 * The composer's submit path, not the supervisor's `item.started` echo — that
 * echo is deduped by item id on both the renderer and the database side, so a
 * flag set there never reaches a screen. Driving the real store through the
 * real action is the only assertion that can tell a rendered dim from an inert
 * one.
 */
async function submitInto(status: ThreadStatus): Promise<RuntimeChatItem | undefined> {
  const thread = guiThread(status);
  useAppStore.setState({
    projects: [project],
    threads: [thread],
    runtimeItemIdsByThread: {},
    runtimeItemsByIdByThread: {},
  });
  await performThreadInputSubmit({
    thread,
    prompt: "wait for me",
    transport: {
      sendThreadInput: vi.fn<(payload: SendThreadInputPayload) => Promise<void>>(async () => {}),
    },
  });
  const state = useAppStore.getState();
  const itemId = state.runtimeItemIdsByThread["thread-1"]?.at(-1);
  return itemId ? state.runtimeItemsByIdByThread["thread-1"]?.[itemId] : undefined;
}

describe("UserMessage after a composer submit", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the row dimmed when the submit lands on a running turn", async () => {
    const item = await submitInto("working");

    expect(item).toBeDefined();
    expect(renderItem(item!)?.dataset.pendingDelivery).toBe("true");
  });

  it("renders the row normally when the submit opens its own turn", async () => {
    const item = await submitInto("idle");

    expect(item).toBeDefined();
    expect(renderItem(item!)?.dataset.pendingDelivery).toBeUndefined();
  });
});
