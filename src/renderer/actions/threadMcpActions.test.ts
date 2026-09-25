import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, StartThreadPayload, Thread } from "@/shared/contracts";
import { mcpServerSchema } from "@/shared/contracts";
import { useAppStore } from "@/renderer/state/appStore";
import { useSharedSettings } from "@/renderer/state/sharedSettingsStore";
import { changeThreadMcp as changeWithCapabilities } from "./threadMcpActions";

const changeThreadMcp = (id: string, change: Parameters<typeof changeWithCapabilities>[1]) =>
  changeWithCapabilities(id, change, { supportsResume: true });

const bridge = vi.hoisted(() => ({
  closeThread: vi.fn<() => Promise<void>>(),
  startThread: vi.fn<(payload: StartThreadPayload) => Promise<{ threadId: string }>>(),
}));
vi.mock("@/renderer/bridge", () => ({ readBridge: () => bridge, hasBridge: () => false }));
vi.mock("@/renderer/analytics/posthog", () => ({
  captureThreadStarted: vi.fn<() => void>(),
  captureThreadPromptSubmitted: vi.fn<() => void>(),
}));

const server = mcpServerSchema.parse({
  id: "web-tools",
  name: "web-tools",
  enabled: false,
  transport: { type: "stdio", command: "node", args: ["fixture.js"] },
});
const project: Project = {
  id: "project",
  name: "Fixture",
  location: { kind: "windows", path: "C:\\fixture" },
  createdAt: "2026-01-01T00:00:00Z",
  mcpServers: [],
};
const thread: Thread = {
  id: "thread",
  projectId: project.id,
  title: "Existing conversation",
  agentKind: "fixture",
  config: { model: "test", browserMcp: false },
  status: "idle",
  attention: "none",
  canResumeWithConfig: true,
  presentationMode: "gui",
  archived: false,
  done: false,
  starred: false,
  sessionRef: { providerSessionId: "original-session", discoveredAt: "2026-01-01T00:00:00Z" },
  worktreePath: "C:\\fixture\\worktree",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("changing tools in an existing conversation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bridge.closeThread.mockResolvedValue();
    bridge.startThread.mockResolvedValue({ threadId: thread.id });
    useAppStore.setState({
      projects: [project],
      threads: [thread],
      connectingThreadIds: {},
      mcpLaunchCustomServerNamesByThreadId: {},
      runtimeItemsByIdByThread: {},
      runtimeItemIdsByThread: {},
    });
    useSharedSettings.setState({
      mcpServers: [server],
      disabledBuiltInMcpServers: {},
      disabledBuiltInMcpTools: {},
    });
  });

  it("resumes the original session and worktree with Browser without sending a new user message", async () => {
    await changeThreadMcp(thread.id, { kind: "builtin", key: "browserMcp", enabled: true });
    expect(bridge.closeThread).toHaveBeenCalledWith({ threadId: thread.id, onlyIfIdle: true });
    expect(bridge.startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: thread.id,
        sessionRef: thread.sessionRef,
        config: { ...thread.config, browserMcp: true, disabledBuiltInMcpServerIds: [] },
        prompt: "",
        projectLocation: { kind: "windows", path: thread.worktreePath },
      }),
    );
    expect(useAppStore.getState().threads).toHaveLength(1);
    expect(useAppStore.getState().runtimeItemIdsByThread[thread.id] ?? []).toEqual([]);
    expect(useAppStore.getState().connectingThreadIds).toEqual({});
  });

  it("resolves newly enabled user MCPs instead of reusing the previous launch snapshot", async () => {
    useAppStore.setState({ mcpLaunchCustomServerNamesByThreadId: { [thread.id]: [] } });
    await changeThreadMcp(thread.id, {
      kind: "custom",
      scope: "user",
      id: server.id,
      enabled: true,
    });
    expect(bridge.startThread.mock.lastCall?.[0].mcpServers).toEqual([
      { ...server, enabled: true },
    ]);
    expect(useAppStore.getState().mcpLaunchCustomServerNamesByThreadId[thread.id]).toEqual([
      server.name,
    ]);
  });

  it("updates workspace overrides without changing the global MCP configuration", async () => {
    useAppStore.setState({
      projects: [{ ...project, mcpServers: [{ ...server, id: "project-server" }] }],
    });
    await changeThreadMcp(thread.id, {
      kind: "custom",
      scope: "project",
      id: "project-server",
      enabled: true,
    });
    expect(bridge.startThread.mock.lastCall?.[0].mcpServers).toEqual([
      { ...server, id: "project-server", enabled: true },
    ]);
    expect(useSharedSettings.getState().mcpServers).toEqual([server]);
  });

  it.each(["working", "launching", "needs_approval", "needs_reply"] as const)(
    "does not interrupt a %s thread",
    async (status) => {
      useAppStore.setState({ threads: [{ ...thread, status }] });
      await expect(
        changeThreadMcp(thread.id, { kind: "builtin", key: "browserMcp", enabled: true }),
      ).rejects.toThrow(/reply/);
      expect(bridge.closeThread).not.toHaveBeenCalled();
    },
  );

  it("leaves choices unchanged if the current runtime cannot be closed", async () => {
    bridge.closeThread.mockRejectedValueOnce(new Error("close failed"));
    await expect(
      changeThreadMcp(thread.id, { kind: "builtin", key: "browserMcp", enabled: true }),
    ).rejects.toThrow("close failed");
    expect(useAppStore.getState().threads[0]?.config.browserMcp).toBe(false);
    expect(bridge.startThread).not.toHaveBeenCalled();
    expect(useAppStore.getState().connectingThreadIds).toEqual({});
  });

  it("never closes a provider that cannot resume its session", async () => {
    await expect(
      changeWithCapabilities(
        thread.id,
        { kind: "builtin", key: "browserMcp", enabled: true },
        { supportsResume: false },
      ),
    ).rejects.toThrow(/reply/);
    expect(bridge.closeThread).not.toHaveBeenCalled();
  });

  it("keeps the original session reference and a usable error state when reconnect fails", async () => {
    bridge.startThread.mockRejectedValueOnce(new Error("MCP launch failed"));
    await expect(
      changeThreadMcp(thread.id, { kind: "builtin", key: "browserMcp", enabled: true }),
    ).rejects.toThrow("MCP launch failed");
    expect(useAppStore.getState().threads[0]).toMatchObject({
      status: "error",
      sessionRef: thread.sessionRef,
    });
    expect(useAppStore.getState().connectingThreadIds).toEqual({});
  });

  it("persists explicit plugin opt-outs and removes only the enabled server's opt-out", async () => {
    await changeThreadMcp(thread.id, { kind: "builtin", key: "browserMcp", enabled: false });
    expect(bridge.startThread.mock.lastCall?.[0].config.disabledBuiltInMcpServerIds).toEqual([
      "browser",
    ]);
    await changeThreadMcp(thread.id, { kind: "builtin", key: "chromeMcp", enabled: false });
    await changeThreadMcp(thread.id, { kind: "builtin", key: "browserMcp", enabled: true });
    expect(bridge.startThread.mock.lastCall?.[0].config.disabledBuiltInMcpServerIds).toEqual([
      "chrome",
    ]);
  });

  it("serializes rapid toggles so the same conversation is not resumed twice", async () => {
    let finish!: () => void;
    bridge.closeThread.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const first = changeThreadMcp(thread.id, { kind: "builtin", key: "browserMcp", enabled: true });
    await changeThreadMcp(thread.id, { kind: "builtin", key: "browserMcp", enabled: false });
    finish();
    await first;
    expect(bridge.startThread).toHaveBeenCalledTimes(1);
    expect(bridge.startThread.mock.lastCall?.[0].config.browserMcp).toBe(true);
  });
});
