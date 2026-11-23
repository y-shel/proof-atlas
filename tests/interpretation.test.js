import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, link, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadGraph } from '../web/graph-model.js';
import { buildInterpretationRequest, interpretationResult, simulateInterpretation, serializeInterpretation } from '../scripts/interpretation.mjs';
import { preflightCodex } from '../scripts/codex_interpretation.mjs';
const raw = JSON.parse(await readFile(new URL('../web/public/demo.json', import.meta.url)));
const model = await loadGraph(raw);
const chunk = raw.chunks.find(c => c.declarationId === 'repeated' && c.occurrenceIds.length === 2);
const temp = await mkdtemp(join(tmpdir(), 'interpretation-'));
const cli = new URL('../scripts/interpret_chunk.mjs', import.meta.url).pathname;
const request = () => buildInterpretationRequest(model, chunk.id);
const response = JSON.stringify({ readings: [{ text: 'A tentative local reading.', citations: [0] }], unknowns: ['Other routes remain in the graph.'] });
test('requests are deterministic, bounded, local and preserve immutable identities', () => {
  const before = JSON.stringify(model.graph), a = request(), b = request();
  assert.equal(a.status, 'ready');
  assert.equal(serializeInterpretation(a), serializeInterpretation(b));
  assert.deepEqual(a.selection.occurrenceIds, chunk.occurrenceIds);
  assert.equal(a.packet.artifactId, raw.artifactId);
  assert.equal(a.model, 'codex-default-unresolved');
  assert.equal(a.packet.evidence.declarations, undefined);
  assert.equal(JSON.stringify(model.graph), before);
  assert.equal(buildInterpretationRequest(model, chunk.id, { packetBytes: 2048 }).status, 'over_limit');
  assert.equal(buildInterpretationRequest(model, chunk.id, { requestBytes: 2048 }).status, 'over_limit');
  assert.equal(buildInterpretationRequest(model, 'absent').status, 'unavailable');
  for (const value of [0, -1, NaN, '2048', 1.5]) assert.throws(() => buildInterpretationRequest(model, chunk.id, { responseBytes: value }));
});
test('simulated proposals resolve exact allowed citations and never verify prose', async () => {
  const r = await simulateInterpretation(model, request(), async () => response);
  assert.equal(r.status, 'ready'); assert.equal(r.execution, 'simulated');
  assert.equal(r.readings[0].verification, 'unverified-interpretation');
  assert.deepEqual(r.readings[0].citations[0], request().packet.citations[0]);
  assert.equal(r.requestId, request().requestId);
  assert.deepEqual(r.selection, request().selection);
  assert.equal(interpretationResult(model, request(), JSON.stringify({ readings: [], unknowns: ['Unknown.'] }), 'simulated').status, 'ready');
});
test('malformed responses and invented, foreign or off-packet citations fail closed', () => {
  for (const value of ['x', '{}', 'null', '{"readings":[],"unknowns":[],"extra":true}', JSON.stringify({ readings: [], unknowns: [] }), JSON.stringify({ readings: [{ text: 'x', citations: [] }], unknowns: [] }), JSON.stringify({ readings: [{ text: 'x', citations: [999999] }], unknowns: [] }), JSON.stringify({ readings: [{ text: 'x', citations: [raw.chunks[0]] }], unknowns: [] })])
    assert.equal(interpretationResult(model, request(), value, 'simulated').status, 'invalid_response');
  const changed = request(); changed.packet.citations[0].artifactId = 'foreign';
  assert.equal(interpretationResult(model, changed, response, 'simulated').status, 'invalid_response');
  const changedModel = structuredClone(raw); changedModel.artifactId = 'foreign';
  assert.equal(interpretationResult(awaitableModel(changedModel), request(), response, 'simulated').status, 'invalid_response');
});
function awaitableModel(g) { return { graph: g }; }
test('response, artifact and time limits produce explicit statuses without retries', async () => {
  let calls = 0;
  const r = request();
  assert.equal(interpretationResult(model, r, 'x'.repeat(r.limits.responseBytes + 1), 'simulated').status, 'over_limit');
  const small = buildInterpretationRequest(model, chunk.id, { artifactBytes: 2048 });
  const large = JSON.stringify({ readings: [{ text: 'x'.repeat(3000), citations: [0] }], unknowns: [] });
  assert.equal(interpretationResult(model, small, large, 'simulated').status, 'over_limit');
  const timed = buildInterpretationRequest(model, chunk.id, { timeoutMs: 10 });
  const result = await simulateInterpretation(model, timed, async signal => { calls++; await new Promise(resolve => signal.addEventListener('abort', resolve)); return response; });
  assert.equal(result.status, 'timeout'); assert.equal(calls, 1);
  assert.equal((await simulateInterpretation(model, r, async () => { throw Error('private secret'); })).status, 'unknown');
});
test('preflight refuses uncertain tool capability and absent CLI without inference', async () => {
  assert.equal((await preflightCodex()).status, 'unavailable');
  assert.equal((await preflightCodex({ executable: join(temp, 'missing') })).status, 'unavailable');
});
test('real CLI prepares by default, refuses live capability, and guards aliases', async () => {
  const graph = join(temp, 'graph.json'); await writeFile(graph, JSON.stringify(raw));
  const output = join(temp, 'result.json');
  execFileSync(process.execPath, [cli, graph, '--chunk', chunk.id, '--output', output]);
  const result = JSON.parse(await readFile(output));
  assert.equal(result.status, 'prepared'); assert.equal(result.execution, 'none');
  assert.equal(JSON.parse(await readFile(output + '.request.json')).requestId, request().requestId);
  execFileSync(process.execPath, [cli, graph, '--chunk', chunk.id, '--output', output, '--run-codex']);
  const denied = JSON.parse(await readFile(output));
  assert.equal(denied.status, 'unavailable'); assert.equal(denied.execution, 'none');
  for (const alias of ['hard', 'symbolic']) {
    const path = join(temp, alias); await (alias === 'hard' ? link(graph, path) : symlink(graph, path));
    assert.throws(() => execFileSync(process.execPath, [cli, graph, '--chunk', chunk.id, '--output', path], { stdio: 'pipe' }));
  }
  assert.throws(() => execFileSync(process.execPath, [cli, graph, '--chunk', chunk.id, '--output', output, '--request-output', output], { stdio: 'pipe' }));
  assert.equal(await readFile(graph, 'utf8'), JSON.stringify(raw));
});
test('fresh medium export and Unicode proof preserve bounded local requests and exact simulated citations', async () => {
  const source = new URL('../experiments/native-extraction/AxiomAudit.lean', import.meta.url).pathname;
  const evidence = join(temp, 'medium-evidence.json'), graph = join(temp, 'medium.json');
  execFileSync('python3', [new URL('../scripts/export_evidence.py', import.meta.url).pathname, source, '--declaration', 'AuditFixture.tallyAppend', '--declaration', 'AuditFixture.unicodeBasis', '--output', evidence]);
  execFileSync('python3', [new URL('../scripts/project_graph.py', import.meta.url).pathname, evidence, '--source', source, '--output', graph]);
  const medium = await loadGraph(JSON.parse(await readFile(graph)));
  for (const name of ['AuditFixture.tallyAppend', 'AuditFixture.unicodeBasis']) {
    const c = medium.chunks(name).find(c => c.text.startsWith(name.endsWith('unicodeBasis') ? 'exact' : 'have shared'));
    if (name.endsWith('tallyAppend')) {
      const bounded = buildInterpretationRequest(medium, c.id);
      assert.equal(bounded.status, 'over_limit');
      assert.deepEqual(bounded.selection.occurrenceIds, c.occurrenceIds);
      assert.equal(bounded.packet, undefined);
    }
    const req = buildInterpretationRequest(medium, c.id, { packetBytes: 262144, requestBytes: 524288 });
    assert.equal(req.status, 'ready');
    assert.equal(req.packet.source.text, c.text);
    assert.equal(req.packet.source.sourceSha256, medium.graph.source.sourceSha256);
    assert.equal(serializeInterpretation(req), serializeInterpretation(buildInterpretationRequest(medium, c.id, req.limits)));
    const result = interpretationResult(medium, req, response, 'simulated');
    assert.equal(result.status, 'ready');
    assert.equal(result.execution, 'simulated');
    assert.deepEqual(result.selection.occurrenceIds, c.occurrenceIds);
    assert.equal(result.readings[0].citations[0].artifactId, medium.graph.artifactId);
    console.log(`${name}: request ${Buffer.byteLength(serializeInterpretation(req))} bytes, simulated response only`);
  }
});
test('request provenance mutation and non-simulated response acceptance are rejected', () => {
  for (const change of [r => { r.requestId = 'foreign'; }, r => { r.packet.source.text = 'injected'; }, r => { r.packet.citations.push({ artifactId: raw.artifactId, path: ['source'] }); }, r => { r.model = 'invented'; }, r => { r.selection.occurrenceIds = []; }]) {
    const r = request(); change(r);
    assert.equal(interpretationResult(model, r, response, 'simulated').status, 'invalid_response');
  }
  assert.throws(() => interpretationResult(model, request(), response, 'live'), /unavailable/);
});
test('missing request envelopes are input errors and inconsistent graph identity cannot become ready', async () => {
  for (const r of [null, {}, { selection: {} }, { selection: { chunkId: chunk.id }, limits: { artifactBytes: 0 } }])
    assert.throws(() => interpretationResult(model, r, response, 'simulated'), /envelope|bound/);
  const bad = structuredClone(raw); bad.evidence.artifactId = 'foreign';
  assert.equal(buildInterpretationRequest(await loadGraph(bad), chunk.id).status, 'unavailable');
});

test('nonexistent destinations through parent aliases and dangling final symlinks cannot overwrite requests', async () => {
  const graph = join(temp, 'alias-graph.json'); await writeFile(graph, JSON.stringify(raw));
  const real = join(temp, 'real-parent'), parentAlias = join(temp, 'parent-alias');
  await mkdir(real); await symlink(real, parentAlias);
  const output = join(real, 'new.json'), requestAlias = join(parentAlias, 'new.json');
  assert.throws(() => execFileSync(process.execPath, [cli, graph, '--chunk', chunk.id, '--output', output, '--request-output', requestAlias], { stdio: 'pipe' }));
  const dangling = join(temp, 'dangling'), future = join(temp, 'future.json');
  await symlink(future, dangling);
  assert.throws(() => execFileSync(process.execPath, [cli, graph, '--chunk', chunk.id, '--output', dangling, '--request-output', future], { stdio: 'pipe' }));
  await assert.rejects(readFile(future));
});
test('simulation rejects tampered provenance before transports or nonready statuses', async () => {
  let calls = 0;
  for (const change of [r => { r.requestId = 'forged'; }, r => { r.model = 'forged'; }, r => { r.status = 'unknown'; }, r => { r.selection.occurrenceIds = []; }]) {
    const r = request(); change(r);
    await assert.rejects(simulateInterpretation(model, r, async () => { calls++; throw Error('failure'); }), /integrity/);
    await assert.rejects(simulateInterpretation(model, r, async () => { calls++; return new Promise(() => {}); }), /integrity/);
  }
  assert.equal(calls, 0);
});
