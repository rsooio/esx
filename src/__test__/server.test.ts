import { strict as assert } from "node:assert";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { suite, test } from "node:test";

const cli = join(dirname(fileURLToPath(import.meta.url)), "../../cli.ts");

type Message = Record<string, any>;

class Server {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<
    string,
    {
      outs: Message[];
      resolve(message: Message): void;
      reject(error: Error): void;
    }
  >();
  private readonly hello: Promise<void>;
  private resolveHello!: () => void;
  private readonly exited: Promise<number | null>;
  private resolveExit!: (code: number | null) => void;
  private stderr = "";

  constructor(cwd: string) {
    this.hello = new Promise((resolve) => {
      this.resolveHello = resolve;
    });
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.child = spawn(process.execPath, [cli, "--server"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    this.child.on("exit", (code) => {
      this.resolveExit(code);
      for (const pending of this.pending.values()) {
        pending.reject(
          new Error(`server exited with ${code}\n${this.stderr}`),
        );
      }
      this.pending.clear();
    });
  }

  ready() {
    return this.hello;
  }

  request(op: string, params: Record<string, unknown> = {}) {
    const id = this.nextId++;
    return new Promise<{ message: Message; outs: Message[] }>(
      (resolve, reject) => {
        const pending = {
          outs: [] as Message[],
          resolve: (_message: Message) => {},
          reject: (_error: Error) => {},
        };
        const timer = setTimeout(() => {
          this.pending.delete(String(id));
          reject(new Error(`timed out waiting for ${op}\n${this.stderr}`));
        }, 5000);
        pending.resolve = (message) => {
          clearTimeout(timer);
          resolve({ message, outs: pending.outs });
        };
        pending.reject = (error) => {
          clearTimeout(timer);
          reject(error);
        };
        this.pending.set(String(id), pending);
        this.child.stdin.write(
          JSON.stringify({ id, op, ...params }) + "\n",
        );
      },
    );
  }

  async quit() {
    this.child.stdin.write(JSON.stringify({ id: this.nextId++, op: "quit" }) + "\n");
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for server exit")),
        5000,
      );
      this.exited.then(
        (code) => {
          clearTimeout(timer);
          resolve(code);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
    assert.equal(code, 0);
  }

  kill() {
    this.child.kill();
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    for (
      let newline = this.buffer.indexOf("\n");
      newline >= 0;
      newline = this.buffer.indexOf("\n")
    ) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: Message;
      try {
        message = JSON.parse(line);
      } catch {
        throw new Error(`non-JSON server output: ${line}`);
      }
      if (message.op === "hello") {
        this.resolveHello();
        continue;
      }
      const key = message.id === undefined ? null : String(message.id);
      const pending = key === null ? undefined : this.pending.get(key);
      if (!pending) continue;
      if (message.op === "out" || message.op === "err") {
        pending.outs.push(message);
        continue;
      }
      if (
        Array.isArray(message.status) &&
        (message.status.includes("done") || message.status.includes("error"))
      ) {
        this.pending.delete(key!);
        pending.resolve(message);
      }
    }
  }
}

function outputText(messages: Message[], op: "out" | "err") {
  return messages
    .filter((message) => message.op === op)
    .map((message) => message[op])
    .join("");
}

suite("server", () => {
  test("runs user code in the main context and captures output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "esx-server-"));
    const server = new Server(dir);
    try {
      await server.ready();

      let result = await server.request("eval", {
        ns: "user",
        code: "1 + 1",
      });
      assert.equal(result.message.value, "2");

      result = await server.request("eval", {
        ns: "user",
        code: "const x = 41; x + 1",
      });
      assert.equal(result.message.value, "42");
      result = await server.request("eval", { ns: "user", code: "x" });
      assert.equal(result.message.value, "41");

      result = await server.request("eval", {
        ns: "user",
        code: "await Promise.resolve(7)",
      });
      assert.equal(result.message.value, "7");

      result = await server.request("eval", {
        code: 'console.log("hello", 1); 42',
      });
      assert.equal(result.message.value, "42");
      assert.equal(outputText(result.outs, "out"), "hello 1\n");
      assert.equal(outputText(result.outs, "err"), "");

      result = await server.request("eval", {
        code: 'process.stdout.write("raw\\n"); 1',
      });
      assert.equal(result.message.value, "1");
      assert.equal(outputText(result.outs, "out"), "raw\n");
      assert.equal(outputText(result.outs, "err"), "");

      result = await server.request("eval", {
        code: 'process.stderr.write("err\\n"); 1',
      });
      assert.equal(result.message.value, "1");
      assert.equal(outputText(result.outs, "err"), "err\n");
      assert.equal(outputText(result.outs, "out"), "");

      result = await server.request("eval", {
        code: 'console.error("bad"); 1',
      });
      assert.equal(result.message.value, "1");
      assert.equal(outputText(result.outs, "err"), "bad\n");
      assert.equal(outputText(result.outs, "out"), "");

      result = await server.request("eval", {
        code: "[1] instanceof Array",
      });
      assert.equal(result.message.value, "true");

      result = await server.request("eval", {
        code: "process.exit(1)",
      });
      assert.ok(result.message.status.includes("eval-error"));
      assert.match(result.message.ex.message, /process\.exit/);

      result = await server.request("ping");
      assert.equal(result.message.value, "pong");

      await server.request("eval", { ns: "user", code: "const nsProbe = 1" });
      result = await server.request("ns-vars", { ns: "user" });
      assert.ok(result.message.vars.includes("nsProbe"));

      result = await server.request("ns-list");
      assert.ok(result.message.namespaces.includes("user"));

      await server.request("eval", {
        code: 'JSON.stringify = () => "boom"; 1',
      });
      result = await server.request("ping");
      assert.equal(result.message.value, "pong");

      await server.quit();
    } finally {
      server.kill();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("shares one realm between local files and packages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "esx-server-realm-"));
    try {
      await mkdir(join(dir, "node_modules/foo"), { recursive: true });
      await writeFile(
        join(dir, "node_modules/foo/package.json"),
        JSON.stringify({ name: "foo", type: "module", exports: "./index.js" }),
      );
      await writeFile(
        join(dir, "node_modules/foo/index.js"),
        [
          "export const arr = [1];",
          'export function log() { console.log("package log"); }',
          'export function write() { process.stdout.write("package raw\\n"); }',
          'export function boom() { throw new Error("boom"); }',
        ].join("\n"),
      );
      await writeFile(
        join(dir, "mod.js"),
        [
          "export const arr = [1];",
          'export function log() { console.log("local log"); }',
        ].join("\n"),
      );

      const server = new Server(dir);
      try {
        await server.ready();
        const ns = pathToFileURL(join(dir, "src/main.js")).href;

        let result = await server.request("eval", {
          ns,
          code: 'import { arr } from "foo"; import { arr as local } from "../mod.js"; [arr instanceof Array, local instanceof Array, Array.isArray(arr), Object.getPrototypeOf(arr) === Array.prototype]',
        });
        assert.equal(result.message.value, "[ true, true, true, true ]");

        result = await server.request("eval", {
          ns,
          code: 'import { log } from "foo"; log()',
        });
        assert.equal(result.message.value, "undefined");
        assert.equal(outputText(result.outs, "out"), "package log\n");
        assert.equal(outputText(result.outs, "err"), "");

        result = await server.request("eval", {
          ns,
          code: 'import { write } from "foo"; write()',
        });
        assert.equal(result.message.value, "undefined");
        assert.equal(outputText(result.outs, "out"), "package raw\n");
        assert.equal(outputText(result.outs, "err"), "");

        result = await server.request("eval", {
          ns,
          code: 'import { boom } from "foo"; let ok; try { boom() } catch (error) { ok = error instanceof Error }; ok',
        });
        assert.equal(result.message.value, "true");

        result = await server.request("eval", {
          ns,
          code: 'import { log as localLog } from "../mod.js"; localLog()',
        });
        assert.equal(result.message.value, "undefined");
        assert.equal(outputText(result.outs, "out"), "local log\n");
        assert.equal(outputText(result.outs, "err"), "");

        await server.quit();
      } finally {
        server.kill();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
