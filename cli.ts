#!/usr/bin/env node

if (process.argv.includes("--server")) {
  await import("./src/server.ts");
} else {
  await import("./src/index.ts");
}
