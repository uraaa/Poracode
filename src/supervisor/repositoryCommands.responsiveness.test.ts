import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { build } from "tsdown";

const fixture = vi.hoisted(() => ({
  workerPath: "",
  blocked: new SharedArrayBuffer(4),
  workers: [] as import("node:worker_threads").Worker[],
}));

// Model the observed CreateProcess stall, including the synchronous portion of
// an *async* execFile. Before the fix this blocks the caller for 800ms.
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const run = promisify(actual.execFile);
  return {
    ...actual,
    execFile: Object.assign(() => {}, {
      [promisify.custom]: async (...args: Parameters<typeof run>) => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
        return run(...args);
      },
    }),
  };
});

vi.mock("node:worker_threads", async (original) => {
  const actual = await original<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor() {
        super(
          `
        const { workerData } = require('node:worker_threads');
        const cp = require('node:child_process');
        const execFile = cp.execFile;
        cp.execFile = function(...args) {
          const blocked = new Int32Array(workerData.blocked);
          Atomics.store(blocked, 0, 1);
          Atomics.wait(blocked, 0, 1, 800);
          Atomics.store(blocked, 0, 2);
          return execFile(...args);
        };
        cp.execFile[require('node:util').promisify.custom] = (...args) => {
          let child;
          const promise = new Promise((resolve, reject) => {
            child = cp.execFile(...args, (error, stdout, stderr) => {
              if (error) reject(Object.assign(error, { stdout, stderr }));
              else resolve({ stdout, stderr });
            });
          });
          promise.child = child;
          return promise;
        };
        require(workerData.entry);
      `,
          { eval: true, workerData: { entry: fixture.workerPath, blocked: fixture.blocked } },
        );
        fixture.workers.push(this);
      }
    },
  };
});

import { execGit } from "./git/exec";

let directory: string;
beforeAll(async () => {
  const root = resolve(".tmp");
  await mkdir(root, { recursive: true });
  directory = await mkdtemp(join(root, "spawn-responsiveness-"));
  fixture.workerPath = join(directory, "repositoryCommandWorker.cjs");
  const source = "src/supervisor/repositoryCommands/worker.ts";
  await build({
    config: false,
    entry: { repositoryCommandWorker: source },
    outDir: directory,
    format: "cjs",
    platform: "node",
    target: "node24",
    logLevel: "silent",
  });
});

afterAll(async () => {
  await Promise.all(fixture.workers.map((worker) => worker.terminate()));
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("serves an unrelated RPC while git process creation is synchronously blocked", async () => {
  const { MessageChannel } =
    await vi.importActual<typeof import("node:worker_threads")>("node:worker_threads");
  const { port1, port2 } = new MessageChannel();
  port1.on("message", () => port1.postMessage({ snapshots: [] }));
  try {
    const started = performance.now();
    const command = execGit({ kind: "posix", path: process.cwd() }, ["--version"]);
    const dispatchMs = performance.now() - started;
    // Attach before asserting so a RED failure cannot leak a rejected command.
    const completed = command.catch((error: unknown) => error);
    expect(dispatchMs).toBeLessThan(200);
    await expect.poll(() => Atomics.load(new Int32Array(fixture.blocked), 0)).toBe(1);
    const reply = new Promise<unknown>((accept) => port2.once("message", accept));
    const rpcStarted = performance.now();
    port2.postMessage("getThreadSnapshots");
    await expect(reply).resolves.toEqual({ snapshots: [] });
    const rpcMs = performance.now() - rpcStarted;
    expect(rpcMs).toBeLessThan(200);
    expect(Atomics.load(new Int32Array(fixture.blocked), 0)).toBe(1);
    console.info(
      `[spawn-regression] dispatch=${dispatchMs.toFixed(1)}ms rpc=${rpcMs.toFixed(1)}ms during 800ms spawn stall`,
    );
    expect(await completed).toMatch(/^git version/);
  } finally {
    port1.close();
    port2.close();
  }
});

it("does not serialize interactive patch input to compute a background deduplication key", async () => {
  const stringify = vi.spyOn(JSON, "stringify");
  const command = execGit({ kind: "posix", path: process.cwd() }, ["hash-object", "--stdin"], {
    input: "patch fixture\n".repeat(500_000),
  });
  const synchronousCalls = stringify.mock.calls.length;
  stringify.mockRestore();
  await expect(command).resolves.toMatch(/^[a-f0-9]{40}\s*$/);
  expect(synchronousCalls).toBe(0);
});
