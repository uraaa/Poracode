import { afterEach, expect, it, vi } from "vitest";
const { probe, asyncProbe } = vi.hoisted(() => ({
  probe: vi.fn<(...args: unknown[]) => { status: number | null; stdout?: string; error?: Error }>(),
  asyncProbe: vi.fn<(...args: unknown[]) => Promise<{ stdout: string }>>(),
}));
vi.mock("node:child_process", async (original) => {
  const { promisify } = await import("node:util");
  return {
    ...(await original<object>()),
    spawnSync: probe,
    execFile: Object.assign(() => undefined, { [promisify.custom]: asyncProbe }),
  };
});
import {
  invalidateExecutablePathCache,
  resolveExecutablePathCached as resolveExecutablePath,
  resolveExecutablePathAsync,
} from "./processRuntime";
afterEach(() => {
  invalidateExecutablePathCache();
  vi.useRealTimers();
});
it("shares the executable TTL and explicit invalidation with synchronous gh resolution", () => {
  vi.useFakeTimers();
  invalidateExecutablePathCache();
  probe.mockReturnValue({ status: 0, stdout: "C:\\tools\\gh.exe\n" });
  const first = resolveExecutablePath("gh");
  const coldProbes = probe.mock.calls.length;
  expect(first).toBeTruthy();
  expect(resolveExecutablePath("gh")).toBe(first);
  expect(probe).toHaveBeenCalledTimes(coldProbes);
  vi.advanceTimersByTime(60_001);
  resolveExecutablePath("gh");
  expect(probe).toHaveBeenCalledTimes(coldProbes * 2);
  invalidateExecutablePathCache();
  resolveExecutablePath("gh");
  expect(probe).toHaveBeenCalledTimes(coldProbes * 3);
});

it("does not retain a transient executable probe failure", () => {
  invalidateExecutablePathCache();
  probe.mockReturnValue({ error: new Error("temporary spawn error"), status: null });
  expect(resolveExecutablePath("gh")).toBeUndefined();
  probe.mockReturnValue({ status: 0, stdout: "C:\\tools\\gh.exe\n" });
  expect(resolveExecutablePath("gh")).toBeTruthy();
});

it("retries a negative entry left by an asynchronous executable probe", async () => {
  invalidateExecutablePathCache();
  asyncProbe.mockRejectedValue(new Error("temporary spawn error"));
  expect(await resolveExecutablePathAsync("__poracode_missing_probe__")).toBeUndefined();
  probe.mockReturnValue({ status: 0, stdout: "C:\\tools\\gh.exe\n" });
  expect(resolveExecutablePath("__poracode_missing_probe__")).toBeTruthy();
});
