import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
const { watchers, readFile } = vi.hoisted(() => ({
  watchers:
    vi.fn<
      (
        path: unknown,
        options: unknown,
        listener: (type: string, path: string) => void,
      ) => EventEmitter & { close: () => void }
    >(),
  readFile: vi.fn<(...args: unknown[]) => Promise<string>>(),
}));
vi.mock("node:fs", async (original) => ({ ...(await original<object>()), watch: watchers }));
vi.mock("node:fs/promises", async (original) => ({ ...(await original<object>()), readFile }));
import { ProjectWatcher } from "./projectWatcher";
afterEach(() => vi.useRealTimers());
it("ignores checkpoint/object/log churn but reports index changes and worktree file edits", async () => {
  vi.useFakeTimers();
  const listeners: Array<(type: string, path: string) => void> = [];
  watchers.mockImplementation((_path, _options, listener) => {
    listeners.push(listener);
    return Object.assign(new EventEmitter(), { close: vi.fn<() => void>() });
  });
  const onGitChanged = vi.fn<(projectId: string, worktreePath?: string) => void>();
  const onTreeChanged = vi.fn<(projectId: string, worktreePath?: string) => void>();
  const watcher = new ProjectWatcher({ onGitChanged, onTreeChanged });
  watcher.watch("p", { kind: "windows", path: "C:\\repo" });
  watcher.watchWorktrees("p", ["C:\\wt"]);
  for (const path of [
    "refs/poracode/checkpoints/1",
    "objects/pack/1",
    "logs/HEAD",
    "index.poracode-1234",
    "index.poracode-1234.lock",
    "worktrees/wt/index.poracode-1234",
    "worktrees/wt/index.poracode-1234.lock",
  ]) {
    listeners[0]!("change", path);
  }
  await vi.advanceTimersByTimeAsync(1000);
  expect(onGitChanged).not.toHaveBeenCalled();
  listeners[0]!("change", "index");
  listeners[2]!("change", "src/file.ts");
  await vi.advanceTimersByTimeAsync(300);
  expect(onGitChanged).toHaveBeenCalledWith("p", "C:\\repo");
  expect(onTreeChanged).toHaveBeenCalledWith("p", "C:\\wt");
  readFile.mockResolvedValue("C:/wt/.git\n");
  readFile.mockClear();
  for (let i = 0; i < 50; i++) listeners[0]!("change", "worktrees/wt/index");
  await vi.advanceTimersByTimeAsync(0);
  expect(onGitChanged).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(300);
  expect(onGitChanged).toHaveBeenLastCalledWith("p", "C:\\wt");
  expect(onGitChanged).toHaveBeenCalledTimes(2);
  expect(readFile).toHaveBeenCalledTimes(1);
  listeners[0]!("change", "HEAD");
  listeners[0]!("change", "refs/remotes/origin/main");
  await vi.advanceTimersByTimeAsync(300);
  expect(onGitChanged).toHaveBeenCalledWith("p");
  expect(onGitChanged).toHaveBeenLastCalledWith("p");
  onGitChanged.mockClear();
  readFile.mockResolvedValue("C:/unwatched/.git\n");
  listeners[0]!("change", "worktrees/cli-only/HEAD");
  await vi.advanceTimersByTimeAsync(300);
  expect(onGitChanged).not.toHaveBeenCalled();
  watcher.watchWorktrees("p", []);
  listeners[0]!("change", "worktrees/wt/index");
  await vi.advanceTimersByTimeAsync(300);
  expect(onGitChanged).not.toHaveBeenCalled();
  await watcher.dispose();
});
