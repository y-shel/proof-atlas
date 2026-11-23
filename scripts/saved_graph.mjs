import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadGraph } from "../web/graph-model.js";

export async function guardOutput(output, inputs) {
  const destination = await realpath(output).catch(() => resolve(output));
  const outputStat = await stat(output).catch(() => null);
  for (const input of inputs) {
    if (destination === await realpath(input)) throw Error("Output cannot overwrite input: " + input);
    const sourceStat = await stat(input);
    if (outputStat && outputStat.dev === sourceStat.dev && outputStat.ino === sourceStat.ino)
      throw Error("Output cannot overwrite input through a hard link: " + input);
  }
}

export async function loadSavedGraph(input) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const saved = await readFile(input, "utf8");
  const validation = promisify(execFile)("python3", ["-c", "import json,sys; sys.path.insert(0,sys.argv[1]); from project_graph import validate_graph; g=json.load(sys.stdin); validate_graph(g,g['evidence'],g['source']['text'].encode('utf-8'))", resolve(root, "scripts")], { timeout: 180000 });
  validation.child.stdin.on("error", () => {});
  validation.child.stdin.end(saved);
  await validation;
  return loadGraph(JSON.parse(saved));
}
