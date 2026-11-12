import { start } from "node:repl";
import { PassThrough } from "node:stream";

const pass = new PassThrough();

const repl = start({
  input: pass,
  output: pass,
  // @ts-expect-error type definition is missing, but the option is valid
  allowBlockingCompletions: true,
});

repl.completer(`import(" `, console.log);
