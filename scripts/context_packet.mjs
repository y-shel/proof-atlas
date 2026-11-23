#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { loadSavedGraph, guardOutput } from "./saved_graph.mjs";
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
  if (options.output) await guardOutput(options.output, [input]);
  const model = await loadSavedGraph(input);
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
