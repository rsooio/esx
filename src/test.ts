const keys = ["user", "tttt"];
const line = ".ns t";
const prefix = line.match(/^\s*\.ns\s+(\S*)$/)?.[1] ?? "";
const hits = keys
  .filter((name) => name.startsWith(prefix))
  .map((line) => line);

console.log(hits);
