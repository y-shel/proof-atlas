#!/usr/bin/env node
import { writeFile, realpath, stat, lstat } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';
import { loadSavedGraph, guardOutput } from './saved_graph.mjs';
import { buildInterpretationRequest, resultStatus, serializeInterpretation } from './interpretation.mjs';
import { runCodexInterpretation } from './codex_interpretation.mjs';
try {
  const args = process.argv.slice(2), input = args.shift();
  if (!input || input === '--help') {
    console.log('node scripts/interpret_chunk.mjs GRAPH --chunk ID --output RESULT [--request-output REQUEST] [--run-codex]\nDefault prepares a bounded request only. --run-codex performs non-inference preflight; live generation is currently unavailable.\nLimits: --packet-bytes --request-bytes --response-bytes --artifact-bytes --timeout-ms N');
    process.exit(input ? 0 : 1);
  }
  const options = {}, limitNames = { '--packet-bytes': 'packetBytes', '--request-bytes': 'requestBytes', '--response-bytes': 'responseBytes', '--artifact-bytes': 'artifactBytes', '--timeout-ms': 'timeoutMs' }, limits = {};
  while (args.length) {
    const key = args.shift();
    if (Object.hasOwn(options, key) || (limitNames[key] && Object.hasOwn(limits, limitNames[key]))) throw Error('Duplicate option: ' + key);
    if (key === '--run-codex') options[key] = true;
    else if (['--chunk', '--output', '--request-output', ...Object.keys(limitNames)].includes(key) && args.length) {
      const value = args.shift();
      if (limitNames[key]) limits[limitNames[key]] = Number(value); else options[key] = value;
    } else throw Error('Unknown or incomplete argument: ' + key);
  }
  if (!options['--chunk'] || !options['--output']) throw Error('--chunk and --output are required');
  const output = options['--output'], requestOutput = options['--request-output'] ?? output + '.request.json';
  await guardOutput(output, [input]); await guardOutput(requestOutput, [input]);
  const identity = async path => {
    const absolute = resolve(path);
    const metadata = await lstat(absolute).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (metadata) return realpath(absolute);
    return join(await realpath(dirname(absolute)), basename(absolute));
  };
  if (await identity(output) === await identity(requestOutput)) throw Error('Request and result outputs must differ');
  const a = await stat(output).catch(() => null), b = await stat(requestOutput).catch(() => null);
  if (a && b && a.dev === b.dev && a.ino === b.ino) throw Error('Request and result outputs are hard-link aliases');
  const model = await loadSavedGraph(input);
  const request = buildInterpretationRequest(model, options['--chunk'], limits);
  const result = options['--run-codex'] ? await runCodexInterpretation(request) : resultStatus(request, request.status === 'ready' ? 'prepared' : request.status, 'none', 'No inference requested. Live generation is currently unavailable');
  await writeFile(requestOutput, serializeInterpretation(request));
  await writeFile(output, serializeInterpretation(result));
  console.error(result.status + ' · execution=' + result.execution + ' · Lean not replayed');
} catch (error) { console.error('Interpretation failed: ' + error.message); process.exitCode = 1; }
