import { afterEach, expect, it, vi } from "vitest";
import { drainSupervisorShutdown } from "./shutdown";
import { repositoryMutation } from "./scheduling";

afterEach(() => vi.useRealTimers());

it("lets an accepted multi-command mutation issue its remaining commands before disposal", async () => {
  const firstCommand = Promise.withResolvers<void>();
  let disposed = false;
  let rejectedSecondCommand = false;
  const mutation = repositoryMutation(async () => {
    await firstCommand.promise;
    rejectedSecondCommand = disposed;
  });
  const result = drainSupervisorShutdown(
    async () => undefined,
    async () => {
      disposed = true;
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  firstCommand.resolve();
  await Promise.all([mutation, result]);
  expect(rejectedSecondCommand).toBe(false);
  expect(disposed).toBe(true);
});

it("stops runtime producers before draining accepted repository mutations", async () => {
  const stopped = Promise.withResolvers<void>();
  const commands = vi.fn<() => Promise<void>>(async () => undefined);
  const result = drainSupervisorShutdown(() => stopped.promise, commands);
  expect(commands).not.toHaveBeenCalled();
  stopped.resolve();
  await result;
  expect(commands).toHaveBeenCalledOnce();
});

it("still drains repository commands if runtime disposal fails", async () => {
  const commands = vi.fn<() => Promise<void>>(async () => undefined);
  await expect(
    drainSupervisorShutdown(async () => {
      throw new Error("runtime");
    }, commands),
  ).rejects.toThrow("runtime");
  expect(commands).toHaveBeenCalledOnce();
});

it("bounds shutdown at thirty seconds without terminating a running mutation", async () => {
  vi.useFakeTimers();
  const mutation = Promise.withResolvers<void>();
  const result = drainSupervisorShutdown(
    async () => undefined,
    () => mutation.promise,
  );
  let done = false;
  void result.then(() => {
    done = true;
  });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(25_000);
  await result;
  expect(done).toBe(true);
  mutation.resolve();
});
