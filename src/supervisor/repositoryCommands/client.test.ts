import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { build } from "tsdown";
import { RepositoryCommandClient } from "./client";
import { invalidateExecutablePathCache } from "../agents/base/processRuntime";

let directory: string;
const clients: RepositoryCommandClient[] = [];
beforeAll(async () => {
  await mkdir(resolve(".tmp"), { recursive: true });
  directory = await mkdtemp(resolve(".tmp/repository-worker-"));
  await build({
    config: false,
    entry: { repositoryCommandWorker: "src/supervisor/repositoryCommands/worker.ts" },
    outDir: directory,
    format: "cjs",
    platform: "node",
    target: "node24",
    logLevel: "silent",
  });
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.dispose()));
});
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

function makeClient(): RepositoryCommandClient {
  const client = new RepositoryCommandClient(
    () => new Worker(join(directory, "repositoryCommandWorker.cjs")),
  );
  clients.push(client);
  return client;
}

function nodeCommand(script: string) {
  return { command: process.execPath, args: ["-e", script], options: { windowsHide: true } };
}

it("multiplexes results and preserves cwd, scoped env, Unicode and stdin", async () => {
  const client = makeClient();
  const requests = Array.from({ length: 4 }, (_, index) =>
    client.run({
      ...nodeCommand(
        "process.stdin.setEncoding('utf8'); let s=''; process.stdin.on('data', c=>s+=c); process.stdin.on('end',()=>{process.stdout.write(process.env.FIXTURE+':'+s+':'+process.cwd()); process.stderr.write('diagnostic')})",
      ),
      options: {
        cwd: directory,
        env: { ...process.env, FIXTURE: String(index) },
        windowsHide: true,
      },
      input: "кириллица\n",
    }),
  );
  const results = await Promise.all(requests);
  for (const [index, result] of results.entries()) {
    expect(result).toEqual({ stdout: `${index}:кириллица\n:${directory}`, stderr: "diagnostic" });
  }
});

it("preserves nonzero exit diagnostics across the worker boundary", async () => {
  await expect(
    makeClient().run(
      nodeCommand(
        "process.stdout.write('partial'); process.stderr.write('failure'); process.exit(7)",
      ),
    ),
  ).rejects.toMatchObject({ code: 7, stdout: "partial", stderr: "failure", killed: false });
});

it("preserves ENOENT, timeout and maxBuffer failures", async () => {
  const client = makeClient();
  await expect(
    client.run({ command: "poracode-command-does-not-exist", args: [], options: {} }),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    client.run({
      ...nodeCommand("setInterval(()=>{},1000)"),
      options: { timeout: 100, windowsHide: true },
    }),
  ).rejects.toMatchObject({ killed: true });
  await expect(
    client.run({
      ...nodeCommand("process.stdout.write('x'.repeat(10000))"),
      options: { maxBuffer: 100, windowsHide: true },
    }),
  ).rejects.toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
});

it("reports early exit while writing stdin without an uncaught EPIPE", async () => {
  await expect(
    makeClient().run({
      ...nodeCommand("process.stderr.write('bad args'); process.exit(2)"),
      input: "x".repeat(4 * 1024 * 1024),
    }),
  ).rejects.toMatchObject({ code: 2, stderr: "bad args" });
});

it("rejects all pending calls after worker failure and starts fresh only for new calls", async () => {
  let starts = 0;
  const client = new RepositoryCommandClient(() => {
    starts++;
    return starts === 1
      ? new Worker("setTimeout(() => { throw new Error('fixture crash') }, 50)", { eval: true })
      : new Worker(join(directory, "repositoryCommandWorker.cjs"));
  });
  clients.push(client);
  const results = await Promise.allSettled([
    client.run(nodeCommand("")),
    client.run(nodeCommand("")),
  ]);
  expect(results.every((result) => result.status === "rejected")).toBe(true);
  expect(starts).toBe(1);
  await expect(client.run(nodeCommand("process.stdout.write('recovered')"))).resolves.toMatchObject(
    { stdout: "recovered" },
  );
  expect(starts).toBe(2);
});

it("kills an active child and rejects pending work on shutdown", async () => {
  const client = makeClient();
  const pidFile = join(directory, "child.pid");
  const pending = client.run({
    ...nodeCommand(
      "require('node:fs').writeFileSync(process.env.PID_FILE,String(process.pid)); setInterval(()=>{},1000)",
    ),
    options: { timeout: 10_000, windowsHide: true, env: { ...process.env, PID_FILE: pidFile } },
  });
  const rejected = pending.catch((error: unknown) => error);
  await expect
    .poll(() => readFile(pidFile, "utf8").catch(() => ""), { timeout: 5000 })
    .toMatch(/^\d+$/);
  const pid = Number(await readFile(pidFile, "utf8"));
  await client.dispose();
  expect(await rejected).toMatchObject({ message: "Repository command client is disposed" });
  expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  await expect(client.run(nodeCommand(""))).rejects.toThrow(/disposed/);
});

it.skipIf(process.platform !== "win32")(
  "resolves once across native prepared commands and honors worker invalidation and TTL",
  async () => {
    const shared = new SharedArrayBuffer(8);
    const counters = new Int32Array(shared);
    const client = new RepositoryCommandClient(
      () =>
        new Worker(
          `
    const { workerData } = require('node:worker_threads');
    const counts = new Int32Array(workerData.shared);
    const now = Date.now;
    Date.now = () => now() + Atomics.load(counts, 1);
    const cp = require('node:child_process');
    const { promisify } = require('node:util');
        cp.spawnSync = (command) => {
          if (!/reg\\.exe$/i.test(command)) throw new Error('Unexpected synchronous lookup: '+command);
          return { status: 1, stdout: '' };
        };
    const wrapper = (...args) => cp.execFile(...args);
    wrapper[promisify.custom] = (command, args, options) => {
      if (/where\\.exe$/i.test(command)) {
        Atomics.add(counts, 0, 1);
        return Promise.resolve({ stdout: process.execPath+'\\n', stderr: '' });
      }
          return Promise.resolve({ stdout: 'ok', stderr: '' });
    };
    const original = cp.execFile;
    cp.execFile = Object.assign((...args) => original(...args), { [promisify.custom]: wrapper[promisify.custom] });
    require(workerData.entry);
  `,
          {
            eval: true,
            workerData: { entry: join(directory, "repositoryCommandWorker.cjs"), shared },
          },
        ),
    );
    clients.push(client);
    const command = {
      ...nodeCommand("process.stdout.write('ok')"),
      command: "fixture-cli",
      preparation: { location: { kind: "windows" as const, path: directory } },
    };
    const results = await Promise.all(Array.from({ length: 8 }, () => client.run(command)));
    expect(results.every((result) => result.stdout === "ok")).toBe(true);
    expect(counters[0]).toBe(1);
    invalidateExecutablePathCache();
    await client.run(command);
    expect(counters[0]).toBe(2);
    Atomics.store(counters, 1, 60_001);
    await client.run(command);
    expect(counters[0]).toBe(3);
  },
);
