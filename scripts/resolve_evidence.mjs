#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { loadSavedGraph, guardOutput } from "./saved_graph.mjs";
import { resolveEvidence, serializeEvidenceResult, DEFAULT_EVIDENCE_BYTES } from "../web/evidence-resolver.js";

try {
  const args = process.argv.slice(2), input = args.shift();
  if (!input || input === "--help") {
    console.log("node scripts/resolve_evidence.mjs GRAPH --anchor ANCHOR_JSON_FILE --output RESULT [--max-bytes N]\nResolve one exact artifact/path anchor. Full saved projection validation precedes retrieval. No Lean execution or provider calls.");
    process.exit(input ? 0 : 1);
  }
  const options = {};
  while (args.length) {
    const key = args.shift();
    if (["--anchor", "--output", "--max-bytes"].includes(key) && args.length) options[key.slice(2)] = args.shift();
    else throw Error("Unknown or incomplete argument: " + key);
  }
  if (!options.anchor || !options.output) throw Error("--anchor and --output are required");
  await guardOutput(options.output, [input, options.anchor]);
  const request = JSON.parse(await readFile(options.anchor, "utf8"));
  const model = await loadSavedGraph(input);
  const result = resolveEvidence(model, request, { maxBytes: options["max-bytes"] === undefined ? DEFAULT_EVIDENCE_BYTES : Number(options["max-bytes"]) });
  await writeFile(options.output, serializeEvidenceResult(result));
  console.error(result.status + " · complete saved projection validated before retrieval; Lean not replayed");
} catch (error) {
  console.error("Retrieval failed: " + error.message);
  process.exitCode = 1;
}
