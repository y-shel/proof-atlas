import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  loadGraph,
  declarationBasis,
  sourceParts,
  overview,
  witnessValue,
} from "../web/graph-model.js";
const raw = JSON.parse(
  await readFile(new URL("../web/public/demo.json", import.meta.url)),
);
test("immutable evidence and declaration filtering", async () => {
  const m = await loadGraph(raw);
  assert.ok(Object.isFrozen(m.graph.evidence));
  assert.ok(m.chunks("repeated").every((c) => c.declarationId === "repeated"));
  assert.ok(m.chunks("localFact", true).length > m.chunks("localFact").length);
});
test("verified UTF8 source regions and tamper rejection", async () => {
  const m = await loadGraph(raw);
  for (const c of m.chunks("branches"))
    assert.equal(sourceParts(m, c)?.[1], c.text);
  const bad = structuredClone(raw);
  bad.source.text += " ";
  await assert.rejects(loadGraph(bad), /Source/);
  assert.equal(
    sourceParts(m, {
      source: { classification: "synthetic", startByte: 0, endByte: 2 },
    }),
    null,
  );
});
test("overview links retain actual containment witnesses only", async () => {
  const m = await loadGraph(raw);
  const v = overview(m, "localFact");
  for (const l of v.links) {
    assert.ok(l.edges.length);
    for (const e of l.edges) {
      assert.equal(e.kind, "contains");
      assert.notEqual(witnessValue(m, e), undefined);
    }
  }
  assert.ok(v.nodes.length);
});
test("repeated source actions retain every execution", async () => {
  const m = await loadGraph(raw);
  assert.ok(m.chunks("repeated", true).some((c) => c.occurrenceIds.length > 1));
  assert.throws(
    () => witnessValue(m, { witness: { path: ["__proto__"] } }),
    /path/,
  );
  await assert.rejects(loadGraph({ schemaVersion: "bad" }), /schema/);
});

test("rejects source metadata drift and unresolved witnesses", async () => {
  const bad = structuredClone(raw);
  bad.evidence.project.sourceSha256 = "0".repeat(64);
  await assert.rejects(loadGraph(bad), /Source/);
  const edge = structuredClone(raw);
  edge.edges[0].witness.path = ["records", "absent"];
  await assert.rejects(loadGraph(edge), /path/);
});

test("rejects fabricated containment endpoint with an existing witness", async () => {
  const bad = structuredClone(raw);
  const e = bad.edges.find((e) => e.kind === "contains");
  e.target = e.source;
  await assert.rejects(loadGraph(bad), /containment/);
});

test("rejects edited navigation text and chunk provenance", async () => {
  const bad = structuredClone(raw);
  bad.chunks[0].text = "fabricated proof";
  await assert.rejects(loadGraph(bad), /text/);
  const span = structuredClone(raw);
  span.chunks[0].source.startByte++;
  await assert.rejects(loadGraph(span), /provenance/);
});
test("rejects renderer labels and broken inspector references before publishing model", async () => {
  const bad = structuredClone(raw),
    c = bad.chunks[0];
  c.text = null;
  c.source = { classification: "synthetic", startByte: null, endByte: null };
  c.syntaxKind = 42;
  for (const id of c.occurrenceIds) {
    bad.evidence.records[id].source = c.source;
    bad.evidence.records[id].syntaxKind = 42;
  }
  await assert.rejects(loadGraph(bad), /chunk|label/i);
  const broken = structuredClone(raw);
  const term = Object.values(broken.evidence.records).find(
    (r) => r.kind === "term",
  );
  term.expressionId = "absent";
  await assert.rejects(loadGraph(broken), /reference/i);
  const context = structuredClone(raw);
  Object.values(context.evidence.contexts)[0].locals = null;
  await assert.rejects(loadGraph(context), /context/i);
});

test("declaration basis preserves collected and unavailable provenance", async () => {
  const declaration = { proofStatus: { containsSorry: false, axiomAudit:
    { status: "collected", axioms: [], containsAdmission: false } } };
  assert.deepEqual(declarationBasis(declaration), {
    status: "collected", axioms: [], containsAdmission: false, directAdmission: false,
  });
  for (const status of ["unknown", "error"]) {
    declaration.proofStatus.axiomAudit = { status, reason: "not available" };
    assert.equal(declarationBasis(declaration).status, status);
    assert.equal(declarationBasis(declaration).reason, "not available");
    assert.equal(declarationBasis(declaration).containsAdmission, null);
  }
  delete declaration.proofStatus.axiomAudit;
  declaration.proofStatus.transitiveTrust = "unscanned";
  assert.equal(declarationBasis(declaration).status, "unknown");
  for (const audit of [null, [], {status: "collected"},
    {status: "collected", axioms: [], containsAdmission: true},
    {status: "collected", axioms: [{tag: "str", value: "bad"}], containsAdmission: false},
    {status: "unknown", reason: "missing", axioms: []},
    {status: "approved"}]) {
    declaration.proofStatus.axiomAudit = audit;
    assert.equal(declarationBasis(declaration).status, "error");
    assert.equal(declarationBasis(declaration).containsAdmission, null);
  }
  const graph = structuredClone(raw);
  graph.evidence.declarations[0].proofStatus = declaration.proofStatus;
  const model = await loadGraph(graph);
  assert.equal(declarationBasis(model.declarations[0]).status, "error");
});

test("axiom Names use Lean structural ordering and exact numeric components", () => {
  const anonymous = {tag: "anonymous"};
  const name = value => ({tag: "str", parent: anonymous, value});
  const declaration = {proofStatus: {axiomAudit: {
    status: "collected", containsAdmission: false,
    axioms: [{tag: "num", parent: anonymous, value: "9007199254740992"},
      {tag: "num", parent: anonymous, value: "9007199254740993"}, name("Ｚ"), name("𝕫")],
  }}};
  assert.equal(declarationBasis(declaration).status, "collected");
  const axioms = declaration.proofStatus.axiomAudit.axioms;
  [axioms[2], axioms[3]] = [axioms[3], axioms[2]];
  assert.equal(declarationBasis(declaration).status, "error");
  declaration.proofStatus.axiomAudit.axioms = [name("same"), name("same")];
  assert.equal(declarationBasis(declaration).status, "error");
});
