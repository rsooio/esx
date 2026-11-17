import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli = join(dirname(fileURLToPath(import.meta.url)), "../../cli.ts");

async function waitFor(predicate: () => boolean, timeout = 5000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) {
      throw new Error("Timed out waiting for REPL output");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("local REPL uses the parent API", async () => {
  const child = spawn(process.execPath, [cli], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
  });

  try {
    await waitFor(() => stdout.includes("user>"));
    child.stdin.write("1 + 1\n");
    await waitFor(() => stdout.includes("2"));
    child.stdin.write(".exit\n");
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for REPL exit")),
        5000,
      );
      exited.then((code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    assert.equal(code, 0);
    assert.equal(stderr, "");
  } finally {
    child.kill();
  }
});
