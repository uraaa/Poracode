import { describe, expect, it, vi } from "vitest";
import {
  getRepositoryCommandPriority,
  pollingRepositoryRequest,
  scheduleRepositoryCommand,
  repositoryMutation,
  getRepositoryReadEpoch,
} from "./scheduling";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("repository command scheduling", () => {
  it("reserves local background slots while a network fetch is stalled", async () => {
    const fetch = Promise.withResolvers<string>();
    const network = scheduleRepositoryCommand("network", "network-stall", () => fetch.promise);
    const secondGate = Promise.withResolvers<string>();
    const secondFetch = scheduleRepositoryCommand(
      "network",
      "network-wait",
      () => secondGate.promise,
    );
    const started: string[] = [];
    const locals = [1, 2].map((id) =>
      scheduleRepositoryCommand("background", `local:${id}`, async () => {
        started.push(String(id));
      }),
    );
    await flush();
    try {
      expect(started).toEqual(["1", "2"]);
    } finally {
      fetch.resolve("first");
      secondGate.resolve("second");
      await Promise.all([network, secondFetch, ...locals]);
    }
  });
  it("runs at most two background commands and starts waiting commands in order", async () => {
    const started: number[] = [];
    const gates = Array.from({ length: 4 }, () => Promise.withResolvers<number>());
    const requests = gates.map((gate, index) =>
      scheduleRepositoryCommand("background", `limit:${index}`, () => {
        started.push(index);
        return gate.promise;
      }),
    );
    await flush();
    expect(started).toEqual([0, 1]);
    gates[1]!.resolve(1);
    await flush();
    expect(started).toEqual([0, 1, 2]);
    gates[0]!.resolve(0);
    await flush();
    expect(started).toEqual([0, 1, 2, 3]);
    gates[2]!.resolve(2);
    gates[3]!.resolve(3);
    expect(await Promise.all(requests)).toEqual([0, 1, 2, 3]);
  });

  it("coalesces queued and running commands but runs a new command after completion", async () => {
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const occupied = gates.map((gate, index) =>
      scheduleRepositoryCommand("background", `occupied:${index}`, () => gate.promise),
    );
    const target = Promise.withResolvers<string>();
    const task = vi.fn<() => Promise<string>>(() => target.promise);
    const first = scheduleRepositoryCommand("background", "coalesce", task);
    const queued = scheduleRepositoryCommand("background", "coalesce", task);
    expect(queued).toBe(first);
    await flush();
    expect(task).not.toHaveBeenCalled();
    gates[0]!.resolve();
    await flush();
    expect(task).toHaveBeenCalledTimes(1);
    expect(scheduleRepositoryCommand("background", "coalesce", task)).toBe(first);
    target.resolve("snapshot");
    expect(await first).toBe("snapshot");
    expect(await scheduleRepositoryCommand("background", "coalesce", async () => "fresh")).toBe(
      "fresh",
    );
    gates[1]!.resolve();
    await Promise.all(occupied);
  });

  it("lets interactive commands bypass occupied background slots and duplicate keys", async () => {
    const gates = [Promise.withResolvers<string>(), Promise.withResolvers<string>()];
    const occupied = gates.map((gate, index) =>
      scheduleRepositoryCommand("background", `bypass:${index}`, () => gate.promise),
    );
    await flush();
    expect(
      await scheduleRepositoryCommand("interactive", "bypass:0", async () => "interactive"),
    ).toBe("interactive");
    gates.forEach((gate) => gate.resolve("background"));
    await Promise.all(occupied);
  });

  it("releases slots and duplicate keys after asynchronous and synchronous failures", async () => {
    const failed = scheduleRepositoryCommand("background", "failure", async () => {
      throw new Error("command failed");
    });
    const synchronous = scheduleRepositoryCommand("background", "sync-failure", () => {
      throw new Error("synchronous failure");
    });
    const queued = scheduleRepositoryCommand("background", "after-failure", async () => "next");
    await expect(failed).rejects.toThrow("command failed");
    await expect(synchronous).rejects.toThrow("synchronous failure");
    expect(await queued).toBe("next");
    expect(await scheduleRepositoryCommand("background", "failure", async () => "retry")).toBe(
      "retry",
    );
  });
});

describe("polling repository requests", () => {
  it("evicts hung requests after30seconds and ignores their late cleanup", async () => {
    vi.useFakeTimers();
    try {
      const old = Promise.withResolvers<string>();
      const stuck = pollingRepositoryRequest("watchdog", () => old.promise).catch(
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await stuck).toMatchObject({ message: "Repository polling request timed out" });
      const replacement = Promise.withResolvers<string>();
      const task = vi.fn<() => Promise<string>>(() => replacement.promise);
      const next = pollingRepositoryRequest("watchdog", task);
      old.resolve("stale");
      await vi.advanceTimersByTimeAsync(0);
      expect(pollingRepositoryRequest("watchdog", task)).toBe(next);
      expect(task).toHaveBeenCalledTimes(1);
      replacement.resolve("fresh");
      expect(await next).toBe("fresh");
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates shared-worktree metadata before and after a failed mutation", async () => {
    const initial = getRepositoryReadEpoch();
    await expect(
      repositoryMutation(async () => {
        expect(getRepositoryReadEpoch()).toBeGreaterThan(initial);
        throw new Error("partial mutation");
      }),
    ).rejects.toThrow("partial mutation");
    expect(getRepositoryReadEpoch()).toBeGreaterThan(initial + 1);
  });
  it("propagates background priority across awaits without changing concurrent interactive calls", async () => {
    expect(getRepositoryCommandPriority()).toBe("interactive");
    const gate = Promise.withResolvers<void>();
    const polling = pollingRepositoryRequest("context", async () => {
      expect(getRepositoryCommandPriority()).toBe("background");
      await gate.promise;
      return getRepositoryCommandPriority();
    });
    await flush();
    expect(getRepositoryCommandPriority()).toBe("interactive");
    gate.resolve();
    expect(await polling).toBe("background");
    expect(getRepositoryCommandPriority()).toBe("interactive");
  });

  it("coalesces whole requests and releases the request key after success and failure", async () => {
    const gate = Promise.withResolvers<string>();
    const task = vi.fn<() => Promise<string>>(() => gate.promise);
    const first = pollingRepositoryRequest("request", task);
    expect(pollingRepositoryRequest("request", task)).toBe(first);
    await flush();
    expect(task).toHaveBeenCalledTimes(1);
    gate.resolve("snapshot");
    expect(await first).toBe("snapshot");
    await expect(
      pollingRepositoryRequest("request", async () => {
        throw new Error("request failed");
      }),
    ).rejects.toThrow("request failed");
    expect(await pollingRepositoryRequest("request", async () => "fresh")).toBe("fresh");
  });

  it("does not consume command slots for outer requests that fan out into commands", async () => {
    const requests = Array.from({ length: 3 }, (_, index) =>
      pollingRepositoryRequest(`fanout:${index}`, () =>
        scheduleRepositoryCommand(
          getRepositoryCommandPriority(),
          `fanout-command:${index}`,
          async () => index,
        ),
      ),
    );
    expect(await Promise.all(requests)).toEqual([0, 1, 2]);
  });
});
