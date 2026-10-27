import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

it("inherits ambient variables when command env contains only overrides", async () => {
  const prior = process.env.PORACODE_TEST_AMBIENT;
  process.env.PORACODE_TEST_AMBIENT = "inherited";
  try {
    const client = makeClient();
    await expect(
      client.run({
        ...nodeCommand(
          "process.stdout.write(process.env.PORACODE_TEST_AMBIENT + ':' + process.env.FIXTURE)",
        ),
        options: { env: { FIXTURE: "override" }, windowsHide: true },
      }),
    ).resolves.toMatchObject({ stdout: "inherited:override" });
    await expect(
      client.run({
        ...nodeCommand("process.stdout.write(process.env.PORACODE_TEST_AMBIENT ?? 'unset')"),
        options: { env: { PORACODE_TEST_AMBIENT: undefined }, windowsHide: true },
      }),
    ).resolves.toMatchObject({ stdout: "unset" });
    await expect(
      client.run(nodeCommand("process.stdout.write(process.env.PORACODE_TEST_AMBIENT)")),
    ).resolves.toMatchObject({ stdout: "inherited" });
  } finally {
    if (prior === undefined) delete process.env.PORACODE_TEST_AMBIENT;
    else process.env.PORACODE_TEST_AMBIENT = prior;
  }
});

it("preserves transferred POSIX shell environment and removes ambient repository scope", async () => {
  const prior = process.env.GH_REPO;
  process.env.GH_REPO = "ambient/repository";
  try {
    await expect(
      makeClient().run({
        ...nodeCommand(
          "process.stdout.write(process.env.FIXTURE + ':' + (process.env.GH_REPO ?? 'unset'))",
        ),
        preparation: {
          location: { kind: "posix", path: directory },
          direct: true,
          shellEnv: { FIXTURE: "main shell" },
          omitEnv: ["GH_REPO"],
        },
      }),
    ).resolves.toMatchObject({ stdout: "main shell:unset" });
  } finally {
    if (prior === undefined) delete process.env.GH_REPO;
    else process.env.GH_REPO = prior;
  }
});

it.each([undefined, "selected/repository"])(
  "keeps prepared PATH and omitted ambient scope when scoped overrides select %s",
  async (repositoryScope) => {
    const prior = process.env.GH_REPO;
    process.env.GH_REPO = "ambient/repository";
    try {
      await expect(
        makeClient().run({
          ...nodeCommand(
            "process.stdout.write([process.env.PATH, process.env.GH_REPO ?? 'unset', process.env.GH_TOKEN].join(':'))",
          ),
          options: {
            windowsHide: true,
            env: {
              GH_TOKEN: "fixture-token",
              ...(repositoryScope ? { GH_REPO: repositoryScope } : {}),
            },
          },
          preparation: {
            location: { kind: "posix", path: directory },
            direct: true,
            shellEnv: { PATH: "primed-path-fixture" },
            omitEnv: ["GH_REPO"],
          },
        }),
      ).resolves.toMatchObject({
        stdout: `primed-path-fixture:${repositoryScope ?? "unset"}:fixture-token`,
      });
    } finally {
      if (prior === undefined) delete process.env.GH_REPO;
      else process.env.GH_REPO = prior;
    }
  },
);

it("sends ambient environment only at worker boot and explicit environment refresh", async () => {
  const requests: Array<{ ambientEnv?: NodeJS.ProcessEnv }> = [];
  const client = new RepositoryCommandClient(() => {
    const worker = new Worker(join(directory, "repositoryCommandWorker.cjs"));
    const postMessage = worker.postMessage.bind(worker);
    worker.postMessage = (request) => {
      requests.push(request);
      postMessage(request);
    };
    return worker;
  });
  clients.push(client);
  await client.run(nodeCommand(""));
  await client.run(nodeCommand(""));
  invalidateExecutablePathCache();
  await client.run(nodeCommand(""));
  expect(requests.map((request) => request.ambientEnv !== undefined)).toEqual([true, false, true]);
});

it("drains interactive work during shutdown without interrupting repository writes", async () => {
  const client = new RepositoryCommandClient(
    () => new Worker(join(directory, "repositoryCommandWorker.cjs")),
    { drainOnShutdown: true },
  );
  clients.push(client);
  const startedFile = join(directory, "write-started");
  const finishedFile = join(directory, "write-finished");
  const pending = client.run({
    ...nodeCommand(
      "const fs=require('node:fs'); fs.writeFileSync(process.env.STARTED,'1'); setTimeout(()=>{fs.writeFileSync(process.env.FINISHED,'done');process.stdout.write('committed')},200)",
    ),
    options: {
      env: { ...process.env, STARTED: startedFile, FINISHED: finishedFile },
      timeout: 5000,
    },
  });
  const result = pending.catch((error: unknown) => error);
  await expect.poll(() => readFile(startedFile, "utf8").catch(() => "")).toBe("1");
  await client.dispose();
  expect(await result).toMatchObject({ stdout: "committed" });
  expect(await readFile(finishedFile, "utf8")).toBe("done");
});

it("finishes an in-flight Git commit on shutdown and releases the index lock", async () => {
  const repository = await mkdtemp(join(directory, "commit-drain-"));
  const client = new RepositoryCommandClient(
    () => new Worker(join(directory, "repositoryCommandWorker.cjs")),
    { drainOnShutdown: true },
  );
  clients.push(client);
  const hooks = join(repository, "test-hooks");
  const started = join(repository, "hook-started");
  const release = join(repository, "hook-release");
  const hookScript = join(repository, "hook.cjs");
  const indexLock = join(repository, ".git", "index.lock");
  const git = (owner: RepositoryCommandClient, args: string[]) =>
    owner.run({
      command: "git",
      args: [
        "-c",
        `core.hooksPath=${hooks}`,
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Shutdown Fixture",
        "-c",
        "user.email=shutdown-fixture@example.invalid",
        ...args,
      ],
      options: { cwd: repository, timeout: 5000, windowsHide: true },
    });
  await git(client, ["init", "--initial-branch=main"]);
  await writeFile(join(repository, "tracked.txt"), "committed fixture\n");
  await git(client, ["add", "--", "tracked.txt"]);
  await mkdir(hooks);
  await writeFile(
    hookScript,
    `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(started)}, 'started');
    const timer = setInterval(() => {
      if (fs.existsSync(${JSON.stringify(release)})) clearInterval(timer);
    }, 10);
    setTimeout(() => process.exit(1), 3000).unref();
  `,
  );
  const shellPath = (path: string) => `'${path.replaceAll("\\", "/").replaceAll("'", "'\"'\"'")}'`;
  await writeFile(
    join(hooks, "pre-commit"),
    `#!/bin/sh\nexec ${shellPath(process.execPath)} ${shellPath(hookScript)}\n`,
    { mode: 0o755 },
  );

  // A partial commit holds index.lock across the hook; a plain commit may
  // release its lock before invoking hooks when the index is already current.
  const committed = git(client, [
    "commit",
    "--only",
    "-m",
    "finish during shutdown",
    "--",
    "tracked.txt",
  ]).catch((error: unknown) => error);
  try {
    await expect.poll(() => readFile(started, "utf8").catch(() => "")).toBe("started");
    expect((await stat(indexLock)).isFile()).toBe(true);
    const disposed = client.dispose();
    await writeFile(release, "release");
    await disposed;
    expect(await committed).toMatchObject({
      stdout: expect.stringContaining("finish during shutdown"),
    });
    await expect(stat(indexLock)).rejects.toMatchObject({ code: "ENOENT" });
    const verifier = makeClient();
    await expect(git(verifier, ["show", "HEAD:tracked.txt"])).resolves.toMatchObject({
      stdout: "committed fixture\n",
    });
  } finally {
    // Also let the hook exit if a pre-shutdown assertion fails.
    await writeFile(release, "release");
    await committed;
  }
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
