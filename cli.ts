#!/usr/bin/env node

if (process.argv.includes("--server")) {
  await import("./src/repl/server.ts");
} else {
  await import("./src/repl/index.ts");
}
