import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadGraph } from '../web/graph-model.js';
const api = await import('../web/context-packet.js').catch(() => ({}));
const raw = JSON.parse(await readFile(new URL('../web/public/demo.json', import.meta.url)));
const model = await loadGraph(raw);
const repeated = raw.chunks.find(c => c.declarationId === 'repeated' && c.occurrenceIds.length === 2);
const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'context-packet-'));
const graphPath = join(temporary, 'small.json');
await writeFile(graphPath, JSON.stringify(raw));
function packet(m = model, id = repeated.id, options) {
  assert.equal(typeof api.buildContextPacket, 'function', 'shared packet builder is available');
  return api.buildContextPacket(m, id, options);
}
function resolve(value, path) { for (const key of path) value = value[key]; return value; }

test('repeated actions retain exact membership, distinct goals, ordered locals and scoped citations', () => {
  const p = packet();
  assert.equal(p.status, 'ready');
  assert.deepEqual(p.chunk, repeated);
  assert.deepEqual(Object.keys(p.evidence.records).sort(), repeated.occurrenceIds.slice().sort());
  const goals = [];
  for (const id of repeated.occurrenceIds) {
    const r = p.evidence.records[id];
    assert.deepEqual(r, raw.evidence.records[id]);
    for (const sid of [...r.beforeGoalSnapshotIds, ...r.afterGoalSnapshotIds]) {
      const s = p.evidence.goalSnapshots[sid]; goals.push(s.goalId);
      assert.deepEqual(s, raw.evidence.goalSnapshots[sid]);
      assert.deepEqual(p.evidence.contexts[s.contextId], raw.evidence.contexts[s.contextId]);
      assert.ok(p.evidence.expressions[s.targetExpressionId]);
    }
  }
  assert.equal(new Set(goals).size, 2);
  for (const a of p.citations) {
    assert.equal(a.artifactId, raw.artifactId);
    assert.deepEqual(resolve(raw, a.path), resolve(p, a.packetPath));
  }
  assert.equal(p.axiomAudit.scope, 'declaration');
  assert.equal(p.axiomAudit.declarationId, 'repeated');
  assert.match(p.verification, /not.*replay/i);
  assert.ok(p.retrieval.length);
});

test('term packets preserve expression/context identity without tactic snapshots and isolate mutations', () => {
  const c = raw.chunks.find(c => c.declarationId === 'termOnly' && c.defaultVisible);
  const p = packet(model, c.id);
  assert.equal(p.status, 'ready');
  assert.equal(Object.keys(p.evidence.goalSnapshots).length, 0);
  for (const r of Object.values(p.evidence.records)) {
    assert.ok(p.evidence.expressions[r.expressionId]);
    assert.ok(p.evidence.contexts[r.contextId]);
    assert.equal(r.beforeGoalSnapshotIds, undefined);
  }
  const before = JSON.stringify(model.graph);
  p.chunk.occurrenceIds.pop();
  Object.values(p.evidence.contexts)[0].locals.length = 0;
  assert.equal(JSON.stringify(model.graph), before);
  assert.equal(packet(model, c.id).chunk.occurrenceIds.length, c.occurrenceIds.length);
});

test('all emitted UTF8 bytes including newline fit, tight bounds emit status and tiny bounds reject', () => {
  const p = packet();
  const bytes = Buffer.byteLength(api.serializeContextPacket(p));
  assert.equal(packet(model, repeated.id, { maxBytes: bytes }).status, 'ready');
  const tight = packet(model, repeated.id, { maxBytes: bytes - 1 });
  assert.equal(tight.status, 'over_limit');
  assert.equal(tight.requiredBytes, bytes);
  assert.equal(tight.evidence, undefined);
  assert.ok(Buffer.byteLength(api.serializeContextPacket(tight)) <= bytes - 1);
  for (const maxBytes of [0, 1, -1, NaN, 1.5, '500'])
    assert.throws(() => packet(model, repeated.id, { maxBytes }), /bound|bytes/i);
  assert.equal(api.serializeContextPacket(p), api.serializeContextPacket(packet()));
});

test('unverified models, unknown chunks and absent scoped evidence never produce ready packets', async () => {
  assert.equal(packet({ graph: raw }).status, 'unavailable');
  assert.equal(packet(model, 'missing').status, 'unavailable');
  const bad = structuredClone(raw);
  const r = bad.evidence.records[repeated.occurrenceIds[0]];
  delete bad.evidence.goals[bad.evidence.goalSnapshots[r.beforeGoalSnapshotIds[0]].goalId];
  assert.equal(packet(await loadGraph(bad)).status, 'unavailable');
  const membership = structuredClone(raw);
  membership.chunks.find(c => c.id === repeated.id).occurrenceIds.pop();
  assert.equal(packet(await loadGraph(membership)).status, 'unavailable');
  const unsupported = structuredClone(raw);
  unsupported.evidence.records[repeated.occurrenceIds[0]].payloadStatus = 'unsupported';
  assert.equal(packet(await loadGraph(unsupported)).status, 'unavailable');
  const legacy = structuredClone(raw);
  delete legacy.evidence.declarations.find(d => d.id === 'repeated').proofStatus.axiomAudit;
  assert.equal(packet(await loadGraph(legacy)).axiomAudit.report.status, 'unknown');
  const malformedAudit = structuredClone(raw);
  malformedAudit.evidence.declarations.find(d => d.id === 'repeated').proofStatus.axiomAudit.containsAdmission = 'no';
  assert.equal(packet(await loadGraph(malformedAudit)).status, 'unavailable');
});

test('resolved references in another local scope cannot be reported ready', async () => {
  for (const kind of ['snapshot', 'term', 'local']) {
    const bad = structuredClone(raw);
    let selected = repeated;
    if (kind === 'snapshot') {
      const r = bad.evidence.records[repeated.occurrenceIds[0]];
      bad.evidence.goalSnapshots[r.beforeGoalSnapshotIds[0]].contextId = 'c0';
    } else if (kind === 'term') {
      selected = raw.chunks.find(c => c.declarationId === 'termOnly' && c.defaultVisible);
      bad.evidence.records[selected.occurrenceIds[0]].contextId = 'c0';
    } else {
      const r = bad.evidence.records[repeated.occurrenceIds[0]];
      const s = bad.evidence.goalSnapshots[r.beforeGoalSnapshotIds[0]];
      const local = bad.evidence.contexts[s.contextId].locals[0];
      bad.evidence.expressions[local.typeExpressionId].contextId = 'c0';
    }
    assert.equal(packet(await loadGraph(bad), selected.id).status, 'unavailable', kind);
  }
});

test('a local type cannot reference its own declaration or a later local', async () => {
  const bad = structuredClone(raw);
  const r = bad.evidence.records[repeated.occurrenceIds[0]];
  const s = bad.evidence.goalSnapshots[r.beforeGoalSnapshotIds[0]];
  const local = bad.evidence.contexts[s.contextId].locals[1];
  bad.evidence.expressions[local.typeExpressionId].expression = {tag: 'fvar', binderDepth: 0, symbolId: local.symbolId};
  assert.equal(packet(await loadGraph(bad)).status, 'unavailable');
});

test('CLI validates reconstruction and shares exact serialization from any working directory', async () => {
  const cli = join(root, 'scripts/context_packet.mjs');
  const output = join(temporary, 'packet.json');
  execFileSync(process.execPath, [cli, graphPath, '--chunk', repeated.id, '--output', output], { cwd: tmpdir() });
  assert.equal(await readFile(output, 'utf8'), api.serializeContextPacket(packet()));
  const drift = structuredClone(raw);
  drift.evidence.goals[Object.keys(drift.evidence.goals)[0]].contextCoverage = 'invented';
  const path = join(temporary, 'drift.json'); await writeFile(path, JSON.stringify(drift));
  assert.throws(() => execFileSync(process.execPath, [cli, path, '--chunk', repeated.id, '--output', output], { stdio: 'pipe' }));
  assert.throws(() => execFileSync(process.execPath, [cli, graphPath, '--chunk', repeated.id, '--output', graphPath], { stdio: 'pipe' }));
  const alias = join(temporary, 'hardlink.json');
  await link(graphPath, alias);
  assert.throws(() => execFileSync(process.execPath, [cli, graphPath, '--chunk', repeated.id, '--output', alias], { stdio: 'pipe' }));
  assert.equal(await readFile(graphPath, 'utf8'), JSON.stringify(raw));
});

test('real medium and Unicode chunks retain useful bounded local evidence with repeated identical bytes', async () => {
  const evidence = join(temporary, 'medium-evidence.json'), graph = join(temporary, 'medium.json');
  const source = join(root, 'experiments/native-extraction/AxiomAudit.lean');
  execFileSync('python3', [join(root, 'scripts/export_evidence.py'), source, '--declaration', 'AuditFixture.tallyAppend', '--declaration', 'AuditFixture.unicodeBasis', '--output', evidence]);
  execFileSync('python3', [join(root, 'scripts/project_graph.py'), evidence, '--source', source, '--output', graph]);
  const medium = await loadGraph(JSON.parse(await readFile(graph)));
  for (const name of ['AuditFixture.tallyAppend', 'AuditFixture.unicodeBasis']) {
    const c = medium.chunks(name).find(c => c.text.startsWith(name.endsWith('unicodeBasis') ? 'exact' : 'have shared'));
    const options = { maxBytes: 256 * 1024 };
    const p = packet(medium, c.id, options), wire = api.serializeContextPacket(p);
    assert.equal(p.status, 'ready');
    assert.equal(p.source.text, c.text);
    assert.ok(Object.keys(p.evidence.contexts).length);
    assert.ok(Object.keys(p.evidence.expressions).length);
    assert.equal(p.source.sourceSha256, medium.graph.source.sourceSha256);
    assert.equal(p.evidence.declarations, undefined);
    assert.equal(p.source.text.includes('namespace AuditFixture'), false);
    assert.ok(Buffer.byteLength(wire) <= options.maxBytes);
    for (const a of p.citations) assert.deepEqual(resolve(medium.graph, a.path), resolve(p, a.packetPath));
    if (name.endsWith('tallyAppend')) assert.equal(packet(medium, c.id).status, 'over_limit');
    for (let i = 0; i < 3; i++) assert.equal(api.serializeContextPacket(packet(medium, c.id, options)), wire);
    console.log(`${name} ${c.id} ${Buffer.byteLength(wire)} bytes`);
  }
  console.log(`small repeated ${Buffer.byteLength(api.serializeContextPacket(packet()))} bytes`);
});
