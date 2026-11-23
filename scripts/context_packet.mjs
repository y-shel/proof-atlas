#!/usr/bin/env node
import { readFile, writeFile, realpath, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadGraph } from "../web/graph-model.js";
import { buildContextPacket, serializeContextPacket, DEFAULT_PACKET_BYTES } from "../web/context-packet.js";

try {
  const args = process.argv.slice(2), input = args.shift();
  if (!input || input === "--help") {
    console.log("node scripts/context_packet.mjs GRAPH --chunk ID --output PACKET [--max-bytes N]\nUse --list instead of --chunk/--output to list source chunk IDs. No Lean execution or provider calls.");
    process.exit(input ? 0 : 1);
  }
  const options = {};
  while (args.length) {
    const key = args.shift();
    if (key === "--list") options.list = true;
    else if (["--chunk", "--output", "--max-bytes"].includes(key) && args.length) options[key.slice(2)] = args.shift();
    else throw Error("Unknown or incomplete argument: " + key);
  }
  if (!options.list && (!options.chunk || !options.output)) throw Error("--chunk and --output are required");
  if (options.output) {
    const destination = await realpath(options.output).catch(() => resolve(options.output));
    if (destination === await realpath(input)) throw Error("Output cannot overwrite input graph");
    const sourceStat = await stat(input), outputStat = await stat(options.output).catch(() => null);
    if (outputStat && outputStat.dev === sourceStat.dev && outputStat.ino === sourceStat.ino) throw Error("Output cannot overwrite input graph through a hard link");
  }
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const saved = await readFile(input, "utf8");
  const validation = promisify(execFile)("python3", ["-c", "import json,sys; sys.path.insert(0,sys.argv[1]); from project_graph import validate_graph; g=json.load(sys.stdin); validate_graph(g,g['evidence'],g['source']['text'].encode('utf-8'))", resolve(root, "scripts")], { timeout: 180000 });
  validation.child.stdin.on("error", () => {});
  validation.child.stdin.end(saved);
  await validation;
  const model = await loadGraph(JSON.parse(saved));
  if (options.list) {
    for (const c of model.graph.chunks) console.log(JSON.stringify({ id: c.id, declarationId: c.declarationId, text: c.text, occurrences: c.occurrenceIds.length }));
  } else {
    const packet = buildContextPacket(model, options.chunk, { maxBytes: options["max-bytes"] === undefined ? DEFAULT_PACKET_BYTES : Number(options["max-bytes"]) });
    await writeFile(options.output, serializeContextPacket(packet));
    console.error(packet.status);
  }
} catch (error) {
  console.error("Packet failed: " + error.message);
  process.exitCode = 1;
}
