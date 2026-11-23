import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, link, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadGraph } from '../web/graph-model.js';
import { buildContextPacket, serializeContextPacket, contextPacketBytes } from '../web/context-packet.js';
const api = await import('../web/evidence-resolver.js').catch(() => ({}));
const raw = JSON.parse(await readFile('web/public/demo.json', 'utf8'));
const model = await loadGraph(raw);
const temporary = await mkdtemp(join(tmpdir(), 'evidence-resolver-'));
const at = (graph, path) => path.reduce((v, k) => v[k], graph);
const anchor = path => ({ artifactId: raw.artifactId, path });
function resolve(m, request, options) {
  assert.equal(typeof api.resolveEvidence, 'function', 'shared exact evidence resolver exists');
  return api.resolveEvidence(m, request, options);
}
function checkPacketAnchors(m, c, maxBytes = 262144) {
  const p = buildContextPacket(m, c.id, { maxBytes });
  assert.equal(p.status, 'ready');
  for (const a of [...p.citations, ...p.retrieval]) {
    const result = resolve(m, a, { maxBytes: 2 * 1024 * 1024 });
    assert.equal(result.status, 'ready');
    assert.deepEqual(result.value, at(m.graph, a.path));
    assert.deepEqual(result.citation, { artifactId: a.artifactId, path: a.path });
    assert.equal(result.scope.kind, 'exact-graph-value');
    assert.deepEqual(result.captureLimits, m.graph.evidence.captureLimits);
    assert.deepEqual(result.capabilities, m.graph.evidence.capabilities);
    assert.equal(result.verification.tier, 'loadGraph');
    assert.equal(serializeContextPacket(result), serializeContextPacket(resolve(m, a, { maxBytes: 2 * 1024 * 1024 })));
    if (a.packetPath) assert.deepEqual(result.value, at(p, a.packetPath));
  }
  const tight = buildContextPacket(m, c.id, { maxBytes: 2000 });
  assert.equal(tight.status, 'over_limit');
  for (const a of tight.retrieval) assert.equal(resolve(m, a, { maxBytes: 2 * 1024 * 1024 }).status, 'ready');
}

test('every citation and retrieval entry from every visible small chunk resolves exactly', () => {
  for (const c of model.graph.chunks.filter(c => c.defaultVisible)) checkPacketAnchors(model, c);
});

test('exact null, booleans, zero, empty strings and Unicode remain available without coercion', async () => {
  const input = structuredClone(raw);
  input.resolverFixture = { null: null, false: false, zero: 0, empty: '', unicode: '∀ café 𝕫', list: [null, false, 0, ''] };
  const m = await loadGraph(input);
  for (const [key, value] of Object.entries(input.resolverFixture)) {
    const r = resolve(m, anchor(['resolverFixture', key]));
    assert.equal(r.status, 'ready');
    assert.deepEqual(r.value, value);
  }
  const unicodeAnchor = anchor(['resolverFixture', 'unicode']);
  const unicode = resolve(m, unicodeAnchor);
  const unicodeBytes = Buffer.byteLength(serializeContextPacket(unicode));
  assert.ok(unicodeBytes > serializeContextPacket(unicode).length);
  assert.equal(resolve(m, unicodeAnchor, { maxBytes: unicodeBytes }).status, 'ready');
  assert.equal(resolve(m, unicodeAnchor, { maxBytes: unicodeBytes - 1 }).requiredBytes, unicodeBytes);
  assert.equal(resolve(m, anchor(['resolverFixture', 'list', 0])).value, null);
  assert.equal(resolve(m, anchor(['resolverFixture', 'list', '0'])).status, 'unavailable');
});

test('results are detached and deterministic; exact UTF8 bounds count the final newline', () => {
  const a = anchor(['chunks', 0]);
  const before = JSON.stringify(model.graph), requestBefore = JSON.stringify(a);
  const r = resolve(model, a);
  const bytes = contextPacketBytes(r);
  assert.equal(resolve(model, a, { maxBytes: bytes }).status, 'ready');
  const tight = resolve(model, a, { maxBytes: bytes - 1 });
  assert.equal(tight.status, 'over_limit');
  assert.equal(tight.requiredBytes, bytes);
  assert.equal(Object.hasOwn(tight, 'value'), false);
  assert.ok(contextPacketBytes(tight) <= bytes - 1);
  r.value.occurrenceIds.pop(); r.citation.path.push('changed'); r.captureLimits.changed = true; r.capabilities.changed = true;
  assert.equal(JSON.stringify(model.graph), before);
  assert.equal(JSON.stringify(a), requestBefore);
  assert.deepEqual(resolve(model, a).value, raw.chunks[0]);
  assert.equal(resolve(model, anchor([])).status, 'over_limit');
  assert.deepEqual(resolve(model, anchor([]), { maxBytes: 32 * 1024 * 1024 }).value, raw);
  for (const maxBytes of [0, 1, -1, NaN, 1.5, '500', Infinity])
    assert.throws(() => resolve(model, a, { maxBytes }), /bound/i);
  assert.throws(() => resolve(model, { artifactId: 'mismatch', path: [] }, { maxBytes: 1 }), /too small/i);
});

test('unverified, mismatched, absent, malformed, inherited and prototype paths are unavailable', () => {
  assert.equal(resolve({ graph: raw }, anchor(['chunks', 0])).status, 'unavailable');
  assert.equal(resolve(model, { artifactId: 'other', path: [] }).status, 'unavailable');
  const paths = [null, 'chunks[0]', ['absent'], ['chunks', '0'], ['chunks', -1], ['chunks', -0], ['chunks', 0.5], ['chunks', Number.MAX_SAFE_INTEGER + 1], ['chunks', null], ['chunks', {}], ['chunks', 'length'], ['chunks', 0, 'toString'], ['__proto__'], ['constructor'], ['prototype'], ['*'], ['chunks', 0, '__proto__'], ['chunks', 0, 0]];
  for (const path of paths) {
    const r = resolve(model, anchor(path));
    assert.equal(r.status, 'unavailable', JSON.stringify(path));
    assert.equal(Object.hasOwn(r, 'value'), false);
  }
  for (const a of [null, [], {}, Object.create(anchor(['chunks', 0]))]) assert.equal(resolve(model, a).status, 'unavailable');
});

test('missing, malformed and internally inconsistent saved artifact identities are unavailable', async () => {
  for (const id of [undefined, '', 'sha256:bad', 'sha256:' + '0'.repeat(64)]) {
    const input = structuredClone(raw);
    if (id === undefined) delete input.artifactId;
    else input.artifactId = id;
    const m = await loadGraph(input);
    assert.equal(resolve(m, { artifactId: id, path: ['chunks', 0] }).status, 'unavailable');
  }
});

test('non-JSON selected values and numeric properties outside array length are unavailable', async () => {
  const input = structuredClone(raw);
  input.resolverFixture = { absent: undefined, nan: NaN, infinity: Infinity, big: 1n, sparse: new Array(1), date: new Date(0) };
  input.chunks[4294967295] = structuredClone(input.chunks[0]);
  const m = await loadGraph(input);
  for (const key of Object.keys(input.resolverFixture)) {
    const r = resolve(m, anchor(['resolverFixture', key]));
    assert.equal(r.status, 'unavailable', key);
    assert.equal(Object.hasOwn(r, 'value'), false);
  }
  assert.equal(resolve(m, anchor(['chunks', 4294967295])).status, 'unavailable');
});

test('CLI validates one saved graph, preserves exact library bytes and protects graph/anchor aliases', async () => {
  const graph = join(temporary, 'small.json'), request = join(temporary, 'anchor.json'), output = join(temporary, 'result.json');
  const a = anchor(['chunks', 0]);
  await writeFile(graph, JSON.stringify(raw)); await writeFile(request, JSON.stringify(a));
  const cli = join(process.cwd(), 'scripts/resolve_evidence.mjs');
  const run = (g = graph, a = request, o = output) => execFileSync(process.execPath, [cli, g, '--anchor', a, '--output', o], { cwd: tmpdir(), stdio: 'pipe' });
  run();
  assert.equal(await readFile(output, 'utf8'), serializeContextPacket(resolve(model, a)));
  for (const input of [graph, request]) {
    const before = await readFile(input, 'utf8');
    assert.throws(() => run(graph, request, input));
    for (const [kind, create] of [['hard', link], ['sym', symlink]]) {
      const alias = join(temporary, kind + input.split('/').at(-1));
      await create(input, alias); assert.throws(() => run(graph, request, alias));
    }
    assert.equal(await readFile(input, 'utf8'), before);
  }
  const drift = structuredClone(raw);
  drift.evidence.goals[Object.keys(drift.evidence.goals)[0]].contextCoverage = 'invented';
  const invalid = join(temporary, 'drift.json'); await writeFile(invalid, JSON.stringify(drift));
  const before = await readFile(output, 'utf8');
  assert.throws(() => run(invalid));
  assert.equal(await readFile(output, 'utf8'), before);
});

test('fresh native medium and Unicode packets round trip all their anchors', async () => {
  const evidence = join(temporary, 'medium-evidence.json'), graph = join(temporary, 'medium.json');
  const source = 'experiments/native-extraction/AxiomAudit.lean';
  execFileSync('python3', ['scripts/export_evidence.py', source, '--declaration', 'AuditFixture.tallyAppend', '--declaration', 'AuditFixture.unicodeBasis', '--output', evidence]);
  execFileSync('python3', ['scripts/project_graph.py', evidence, '--source', source, '--output', graph]);
  const m = await loadGraph(JSON.parse(await readFile(graph, 'utf8')));
  for (const name of ['AuditFixture.tallyAppend', 'AuditFixture.unicodeBasis']) {
    const c = m.chunks(name).find(c => c.text.startsWith(name.endsWith('unicodeBasis') ? 'exact' : 'have shared'));
    checkPacketAnchors(m, c);
    const r = resolve(m, { artifactId: m.graph.artifactId, path: ['evidence', 'declarations', m.declarations.findIndex(d => d.id === name)] });
    console.log(`${name} declaration retrieval ${r.status}, ${contextPacketBytes(r)} emitted bytes, ${r.requiredBytes ?? contextPacketBytes(r)} required, default ${api.DEFAULT_EVIDENCE_BYTES}`);
  }
  console.log(`fresh medium graph ${graph}`);
});
