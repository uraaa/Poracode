import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectLocation } from "@/shared/contracts";

const mocks = vi.hoisted(() => ({
  exec: vi.fn<(location: ProjectLocation, args: string[]) => Promise<string>>(),
  stat: vi.fn<
    (...args: unknown[]) => Promise<{ size: number; mtimeMs: number; isFile: () => boolean }>
  >(),
  readFile: vi.fn<(...args: unknown[]) => Promise<string | Buffer>>(),
}));
vi.mock("./exec", async (original) => ({ ...(await original<object>()), execGit: mocks.exec }));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<object>()),
  stat: mocks.stat,
  readFile: mocks.readFile,
}));
import { GitStatusService } from "./statusService";

const location: ProjectLocation = { kind: "posix", path: "/repo" };
const porcelain = "# branch.head main\n1 MM N... 100644 100644 100644 abc abc file.txt\n";
describe("native polling command volume", () => {
  beforeEach(() => {
    mocks.stat.mockResolvedValue({ size: 10, mtimeMs: 1, isFile: () => true });
    mocks.readFile.mockResolvedValue("");
    mocks.exec.mockImplementation(async (_location, args: string[]) => {
      if (args[0] === "status") return porcelain;
      if (args[0] === "remote") return "origin https://github.com/o/r.git (fetch)\n";
      if (args[0] === "diff" && args[1] !== "--cached") return "3\t1\tfile.txt\n";
      return "";
    });
  });

  it("uses three git invocations for a warm full status and keeps exact counts", async () => {
    const service = new GitStatusService();
    await service.getStatus(location);
    mocks.exec.mockClear();
    const status = await service.getStatus(location);
    console.log("warm full status git invocations:", mocks.exec.mock.calls.length);
    expect(status.totalInsertions).toBe(3);
    expect(status.totalDeletions).toBe(1);
    expect(mocks.exec).toHaveBeenCalledTimes(3);
  });

  it("uses one git invocation for a warm clean worktree", async () => {
    mocks.exec.mockImplementation(async (_location, args: string[]) =>
      args[0] === "status" ? "# branch.head main\n" : "",
    );
    const service = new GitStatusService();
    await service.getStatus(location);
    mocks.exec.mockClear();
    await service.getStatus(location);
    expect(mocks.exec).toHaveBeenCalledTimes(1);
  });

  it("gets individual untracked files from status without a second directory walk", async () => {
    mocks.exec.mockImplementation(async (_location, args: string[]) =>
      args[0] === "status" ? "# branch.head main\n? nested/file.txt\n" : "",
    );
    mocks.readFile.mockResolvedValue(Buffer.from("new\nlines\n"));
    const result = await new GitStatusService().getStatus(location);
    expect(result.totalInsertions).toBe(2);
    expect(mocks.exec.mock.calls.some(([, args]) => args[0] === "ls-files")).toBe(false);
  });

  it("invalidates remote metadata when config changes", async () => {
    const service = new GitStatusService();
    await service.getStatus(location);
    mocks.stat.mockResolvedValue({ size: 20, mtimeMs: 2, isFile: () => true });
    mocks.exec.mockImplementation(async (_location, args: string[]) =>
      args[0] === "status" ? porcelain : "",
    );
    expect((await service.getStatus(location)).hasRemote).toBe(false);
  });

  it.each(["not a git repository", "dubious ownership", "spawn git ENOENT", "ENOENT cwd"])(
    "preserves the non-repo state for %s",
    async (message) => {
      const service = new GitStatusService();
      await service.getStatus(location);
      mocks.exec.mockRejectedValue(new Error(message));
      expect((await service.getStatus(location)).isRepo).toBe(false);
    },
  );

  it("starts fresh reads after a mutation and does not queue UI reads behind a poll", async () => {
    const service = new GitStatusService();
    let finish!: (value: string) => void;
    mocks.exec.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const beforeMutation = service.getStatus(location);
    const afterMutation = await service.getStatus(location);
    expect(afterMutation.totalInsertions).toBe(3);
    finish(porcelain);
    await beforeMutation;
  });

  it("preserves status errors when repository membership still succeeds", async () => {
    mocks.exec.mockImplementation(async (_location, args) => {
      if (args[0] === "status") throw new Error("corrupt index");
      return "true\n";
    });
    await expect(new GitStatusService().getStatus(location)).rejects.toThrow("corrupt index");
  });
});
