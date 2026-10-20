import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { cancelRun, startRun } from "../../src/app/index.js";
import {
  approveToy,
  BUILT_CLI,
  lightWorkload,
  makeToy,
  serverEnv,
  TIMEOUT_MS,
  type Toy,
} from "./helpers.js";

// M2 B1, B5: the built `ufo mcp` on raw stdin and stdout, as a host's process sees it: the
// legacy handshake at any version, a cancelled wait, malformed input, stdout holding only
// protocol messages, and the exit when stdin closes.

interface Message {
  jsonrpc?: string;
  id?: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** `ufo mcp` with its stdout split into lines, each of which must be one JSON-RPC message. */
class RawServer {
  readonly child: ChildProcessWithoutNullStreams;
  readonly lines: string[] = [];
  private buffered = "";

  constructor(toy: Toy) {
    this.child = spawn(
      process.execPath,
      [BUILT_CLI, "mcp", "--host", "cursor", "--repo", toy.repo],
      {
        cwd: toy.root,
        env: serverEnv(toy),
      },
    );
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffered += chunk;
      const parts = this.buffered.split("\n");
      this.buffered = parts.pop() ?? "";
      this.lines.push(...parts);
    });
    this.child.stderr.resume();
  }

  send(message: object | string): void {
    this.child.stdin.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
  }

  messages(): Message[] {
    return this.lines.map((line) => JSON.parse(line) as Message);
  }

  async response(id: number, timeoutMs = 10_000): Promise<Message> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages().find((message) => message.id === id);
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`no response ${id}; got ${this.lines.join("\n")}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async initialize(protocolVersion = "2025-11-25"): Promise<Message> {
    this.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion, capabilities: {}, clientInfo: { name: "raw-test", version: "1" } },
    });
    const answer = await this.response(1);
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return answer;
  }

  /** Closes stdin; resolves with the exit code and how long the exit took. */
  async closeStdin(): Promise<{ code: number | null; ms: number }> {
    const started = Date.now();
    const exited = once(this.child, "exit");
    this.child.stdin.end();
    const [code] = (await exited) as [number | null];
    return { code, ms: Date.now() - started };
  }
}

const toys: Toy[] = [];
const servers: RawServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.child.kill("SIGKILL");
  for (const toy of toys.splice(0)) await toy.cleanup();
});

function serverFor(toy: Toy): RawServer {
  const server = new RawServer(toy);
  servers.push(server);
  return server;
}

function toyFor(setup?: string): Toy {
  const toy = makeToy({ config: lightWorkload(setup) });
  toys.push(toy);
  return toy;
}

/** Every stdout line is one JSON-RPC 2.0 message. */
function expectOnlyProtocol(server: RawServer): void {
  expect(server.lines.length).toBeGreaterThan(0);
  for (const line of server.lines) {
    expect(() => JSON.parse(line), line).not.toThrow();
    expect(JSON.parse(line), line).toMatchObject({ jsonrpc: "2.0" });
  }
}

describe("the legacy handshake", { timeout: TIMEOUT_MS }, () => {
  it.each([
    ["2025-11-25", "2025-11-25"],
    ["2024-11-05", "2024-11-05"],
    // A version the server does not know: answered with one it does, never refused.
    ["2024-01-01", "2025-11-25"],
  ])("answers an initialize for %s with %s", async (asked, answered) => {
    const server = serverFor(toyFor());
    const answer = await server.initialize(asked);
    expect(answer.error).toBeUndefined();
    expect(answer.result).toMatchObject({
      protocolVersion: answered,
      serverInfo: { name: "ufo" },
      capabilities: { tools: expect.any(Object) },
    });
    expect(await server.closeStdin()).toMatchObject({ code: 0 });
    expectOnlyProtocol(server);
  });
});

describe("a cancelled get_job wait", { timeout: TIMEOUT_MS }, () => {
  it("is never answered, and the server exits at once when stdin closes", async () => {
    // The baseline's setup sleeps, so the job stays running with its worker alive.
    const toy = toyFor("sleep 30");
    await approveToy(toy);
    const run = await startRun(toy.context);
    try {
      const server = serverFor(toy);
      await server.initialize();
      server.send({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "get_job",
          arguments: { run_id: run.runId, job_id: run.baselineJobId, wait_s: 25 },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      server.send({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 7, reason: "the user stopped it" },
      });
      server.send({ jsonrpc: "2.0", id: 8, method: "ping" });
      expect(await server.response(8)).toMatchObject({ result: {} });
      // Well past the server's next poll of the job: a response would have been sent by now.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect(server.messages().filter((message) => message.id === 7)).toEqual([]);
      // Nothing still waits: without the cancel, the wait would hold the process for 25 s.
      const exit = await server.closeStdin();
      expect(exit.code).toBe(0);
      expect(exit.ms).toBeLessThan(5000);
      expectOnlyProtocol(server);
    } finally {
      await cancelRun(toy.context, { runId: run.runId });
    }
  });
});

describe("malformed input", { timeout: TIMEOUT_MS }, () => {
  it("is answered or dropped, the server keeps serving, and stdout holds only protocol", async () => {
    const server = serverFor(toyFor());
    await server.initialize();
    server.send("{this is not json");
    server.send({ jsonrpc: "2.0", id: 2, method: "no/such/method" });
    server.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { arguments: {} } });
    server.send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "inspect_target" },
    });
    expect(await server.response(2)).toMatchObject({ error: { code: -32601 } });
    expect(await server.response(3)).toMatchObject({ error: { code: -32602 } });
    const inspected = await server.response(4);
    expect(inspected.result?.structuredContent).toMatchObject({ config: { present: true } });
    const exit = await server.closeStdin();
    expect(exit.code).toBe(0);
    expectOnlyProtocol(server);
  });
});
