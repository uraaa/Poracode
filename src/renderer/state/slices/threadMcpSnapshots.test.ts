import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../appStore";
import { normalizeRuntimeSnapshotLaunchConfig } from "./threadSlice";

const runtimeState = { status: "idle", attention: "none", canResumeWithConfig: true } as const;

describe("runtime custom MCP server names", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({ threads: [], projects: [], mcpLaunchCustomServerNamesByThreadId: {} });
  });

  it("accepts authoritative names from automatic launches without a renderer launch", () => {
    useAppStore.getState().updateThreadRuntime("automatic", {
      ...runtimeState,
      mcpLaunchCustomServerNames: ["crm", "plugin-search"],
    });
    expect(useAppStore.getState().mcpLaunchCustomServerNamesByThreadId.automatic).toEqual([
      "crm",
      "plugin-search",
    ]);
    useAppStore
      .getState()
      .updateThreadRuntime("automatic", { ...runtimeState, mcpLaunchCustomServerNames: [] });
    expect(useAppStore.getState().mcpLaunchCustomServerNamesByThreadId.automatic).toEqual([]);
  });

  it("preserves known names on partial legacy status events", () => {
    useAppStore.getState().setThreadMcpLaunchCustomServerNames("thread", ["crm"]);
    useAppStore.getState().updateThreadRuntime("thread", runtimeState);
    expect(useAppStore.getState().mcpLaunchCustomServerNamesByThreadId.thread).toEqual(["crm"]);
  });

  it("hydrates names after reload and drops unknown or ended snapshot entries", () => {
    useAppStore.getState().setThreadMcpLaunchCustomServerNames("ended", ["old"]);
    useAppStore.getState().setThreadMcpLaunchCustomServerNames("legacy", ["old"]);
    useAppStore.getState().reconcileRuntimeSnapshots([
      { ...runtimeState, threadId: "live", mcpLaunchCustomServerNames: ["crm"] },
      { ...runtimeState, threadId: "empty", mcpLaunchCustomServerNames: [] },
      { ...runtimeState, threadId: "legacy" },
    ]);
    expect(useAppStore.getState().mcpLaunchCustomServerNamesByThreadId).toEqual({
      live: ["crm"],
      empty: [],
    });
  });

  it("clears the cached names for exited sessions", () => {
    useAppStore.getState().setThreadMcpLaunchCustomServerNames("exited", ["crm"]);
    useAppStore.getState().markThreadExited("exited");
    expect(useAppStore.getState().mcpLaunchCustomServerNamesByThreadId).toEqual({});
  });

  it("clears launch state at startup", () => {
    useAppStore.getState().setThreadMcpLaunchCustomServerNames("old", ["crm"]);
    useAppStore.getState().markThreadsInactiveOnLaunch();
    expect(useAppStore.getState().mcpLaunchCustomServerNamesByThreadId).toEqual({});
  });

  it("preserves server names when normalizing remote events", () => {
    const snapshot = {
      ...runtimeState,
      threadId: "remote",
      mcpLaunchCustomServerNames: ["remote-crm"],
    };
    useAppStore
      .getState()
      .updateThreadRuntime(snapshot.threadId, normalizeRuntimeSnapshotLaunchConfig(snapshot));
    expect(useAppStore.getState().mcpLaunchCustomServerNamesByThreadId.remote).toEqual([
      "remote-crm",
    ]);
  });
});
