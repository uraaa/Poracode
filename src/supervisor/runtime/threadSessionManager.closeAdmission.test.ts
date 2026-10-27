import { expect, it, vi } from "vitest";
import type { SessionRuntime } from "./sessionTypes";
import { createFollowUpQueueHarness } from "./threadSessionManager.followUpQueueTestHarness";

vi.mock("node-pty", () => ({ spawn: vi.fn<() => never>() }));

function harness() {
  const fixture = createFollowUpQueueHarness();
  fixture.session.adapter.capabilities.supportsResume = true;
  fixture.session.sessionRef = {
    providerSessionId: "resumable",
    discoveredAt: new Date().toISOString(),
  };
  const dispose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  fixture.session.structuredSession!.dispose = dispose;
  return { ...fixture, dispose };
}

it("keeps a queue submission received before its asynchronous insertion", async () => {
  const { manager, session, startTurn, finish, completion, dispose } = harness();
  startTurn.mockImplementationOnce(() => completion);
  try {
    const queued = manager.queueThreadFollowUp({
      threadId: session.threadId,
      prompt: "just received",
      config: session.config,
    });
    await expect(
      manager.closeThread({ threadId: session.threadId, onlyIfIdle: true }),
    ).rejects.toThrow("Wait for the current reply to finish before changing tools.");
    await queued;
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce());
    expect(startTurn.mock.calls[0]?.[0]).toBe("just received");
    expect(dispose).not.toHaveBeenCalled();
  } finally {
    finish();
    await manager.dispose();
  }
});

it("allows idle-only close once a direct command finishes without opening a turn", async () => {
  const { manager, session, startTurn, finish, dispose } = harness();
  startTurn.mockResolvedValueOnce({ outcome: "completed-without-turn" } as never);
  try {
    await manager.sendThreadInput({
      threadId: session.threadId,
      prompt: "/status",
      config: session.config,
    });
    await manager.closeThread({ threadId: session.threadId, onlyIfIdle: true });
    expect(dispose).toHaveBeenCalledOnce();
    expect(manager.sessions.has(session.threadId)).toBe(false);
  } finally {
    finish();
    await manager.dispose();
  }
});

it("keeps an idle session while a queued provider call is awaiting admission", async () => {
  const { manager, session, startTurn, finish, completion, dispose } = harness();
  startTurn.mockImplementationOnce(() => completion);
  try {
    await manager.queueThreadFollowUp({
      threadId: session.threadId,
      prompt: "queued work",
      config: session.config,
    });
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce());
    expect(session.status).toBe("idle");
    await expect(
      manager.closeThread({ threadId: session.threadId, onlyIfIdle: true }),
    ).rejects.toThrow("Wait for the current reply to finish before changing tools.");
    expect(manager.sessions.get(session.threadId)).toBe(session);
    expect(dispose).not.toHaveBeenCalled();
    expect(startTurn.mock.calls[0]?.[0]).toBe("queued work");
  } finally {
    finish();
    await manager.dispose();
  }
});

it("keeps direct input before preparation and after dispatch while status is still idle", async () => {
  const { manager, session, startTurn, finish, completion, dispose } = harness();
  startTurn.mockImplementationOnce(() => completion);
  try {
    const submitted = manager.sendThreadInput({
      threadId: session.threadId,
      prompt: "direct work",
      config: session.config,
    });
    await expect(
      manager.closeThread({ threadId: session.threadId, onlyIfIdle: true }),
    ).rejects.toThrow("Wait for the current reply to finish before changing tools.");
    await submitted;
    expect(session.status).toBe("idle");
    expect(startTurn.mock.calls[0]?.[0]).toBe("direct work");
    await expect(
      manager.closeThread({ threadId: session.threadId, onlyIfIdle: true }),
    ).rejects.toThrow("Wait for the current reply to finish before changing tools.");
    expect(manager.sessions.get(session.threadId)).toBe(session);
    expect(dispose).not.toHaveBeenCalled();
  } finally {
    finish();
    await manager.dispose();
  }
});

it("keeps queued fallback steer content until canonical replacement admission", async () => {
  const { manager, session, startTurn, finish, completion, dispose } = harness();
  session.status = "working";
  delete session.structuredSession!.steerTurn;
  startTurn.mockImplementationOnce(() => completion);
  const steer = (
    manager as unknown as {
      steerCoordinator: {
        maybeDrainPendingSteer(current: SessionRuntime): Promise<void> | undefined;
        noteSteerTurnStarted(current: SessionRuntime): void;
      };
    }
  ).steerCoordinator;
  try {
    await manager.queueThreadFollowUp({
      threadId: session.threadId,
      prompt: "queued replacement",
      config: session.config,
    });
    const item = manager.getThreadFollowUpQueue(session.threadId)!.items[0]!;
    const submitted = manager.steerQueuedThreadFollowUp({
      threadId: session.threadId,
      id: item.id,
    });
    await vi.waitFor(() => expect(session.pendingSteer).toBeDefined());
    session.status = "idle";
    await expect(
      manager.closeThread({ threadId: session.threadId, onlyIfIdle: true }),
    ).rejects.toThrow("Wait for the current reply to finish before changing tools.");
    void steer.maybeDrainPendingSteer(session);
    await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce());
    await expect(
      manager.closeThread({ threadId: session.threadId, onlyIfIdle: true }),
    ).rejects.toThrow("Wait for the current reply to finish before changing tools.");
    expect(manager.getThreadFollowUpQueue(session.threadId)?.items[0]?.prompt).toBe(
      "queued replacement",
    );
    expect(dispose).not.toHaveBeenCalled();
    steer.noteSteerTurnStarted(session);
    await submitted;
    expect(manager.getThreadFollowUpQueue(session.threadId)).toBeNull();
  } finally {
    finish();
    await manager.dispose();
  }
});
