import { isVerifiedGraphModel, declarationBasis } from "./graph-model.js";

export const DEFAULT_PACKET_BYTES = 128 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const tables = ["records", "goalSnapshots", "goals", "contexts", "expressions", "symbols", "universeMetavariables"];
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export const serializeContextPacket = (packet) => JSON.stringify(canonical(packet)) + "\n";
export const contextPacketBytes = (packet) => encoder.encode(serializeContextPacket(packet)).length;

/** Select captured local evidence without changing chunk boundaries or interpreting the proof. */
export function buildContextPacket(model, chunkId, { maxBytes = DEFAULT_PACKET_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw Error("Byte bound must be a positive safe integer");
  const g = model?.graph;
  const anchor = path => ({ artifactId: g?.artifactId ?? null, path });
  const chunkIndex = g?.chunks?.findIndex(c => c.id === chunkId) ?? -1;
  const base = {
    schemaVersion: "proof-atlas.context-packet.v0",
    selectionPolicyVersion: "selected-local-closure.v0",
    artifactId: g?.artifactId ?? null, chunkId,
    retrieval: [anchor(chunkIndex < 0 ? ["chunks"] : ["chunks", chunkIndex])],
  };
  function bounded(result) {
    if (contextPacketBytes(result) > maxBytes) throw Error("Byte bound is too small for the status and retrieval anchors");
    return result;
  }
  try {
    if (!isVerifiedGraphModel(model)) throw Error("A model returned by loadGraph is required");
    if (chunkIndex < 0) throw Error("Selected chunk is unavailable");
    const c = g.chunks[chunkIndex], e = g.evidence;
    if (c.policyVersion !== "source-regions.v0" || g.chunkPolicyVersion !== c.policyVersion)
      throw Error("Unsupported chunk policy");
    const sameGroup = r => r.declarationId === c.declarationId &&
      (r.kind === "partialTerm" ? "term" : r.kind) === c.kind && r.syntaxKind === c.syntaxKind &&
      ["classification", "startByte", "endByte"].every(k => r.source?.[k] === c.source[k]);
    const members = Object.values(e.records).filter(sameGroup).map(r => r.id).sort();
    if (JSON.stringify(members) !== JSON.stringify([...c.occurrenceIds].sort()) || new Set(c.occurrenceIds).size !== members.length)
      throw Error("Chunk membership differs from the complete captured source group");
    if (c.source.classification !== "original" || !Number.isInteger(c.source.startByte) || !Number.isInteger(c.source.endByte))
      throw Error("Verified original local source is unavailable");
    const text = decoder.decode(encoder.encode(g.source.text).slice(c.source.startByte, c.source.endByte));
    if (text !== c.text) throw Error("Chunk source differs from verified bytes");
    const p = {
      ...base, status: "ready",
      verification: "Source SHA256, chunk provenance and referenced evidence checked by loadGraph and local closure checks; Lean and complete graph semantics not replayed by this library. CLI additionally reconstructs the graph before calling it.",
      chunk: structuredClone(c),
      source: { text, sourceSha256: g.source.sourceSha256, sourceByteLength: g.source.sourceByteLength, range: structuredClone(c.source) },
      evidence: Object.fromEntries(tables.map(t => [t, {}])),
      citations: [], references: [],
      capabilities: structuredClone(e.capabilities ?? { status: "unknown" }),
      captureLimits: structuredClone(e.captureLimits ?? { status: "unknown" }),
      coverage: {
        status: e.captureStatus ?? "unknown",
        included: "Selected occurrences, their saved states, ordered local contexts and referenced captured expressions. Axiom provenance is declaration-scoped.",
        notIncluded: ["Other occurrences, branches and descendant records remain retrievable in the graph", "External constant signatures and definitions are not captured", "Metavariable assignments and namespace/options are unavailable; identities do not imply solved goals", "No mathematical necessity, overall story or exhaustive route claim"],
      },
    };
    const cite = (path, packetPath) => p.citations.push({ ...anchor(path), packetPath });
    cite(["chunks", chunkIndex], ["chunk"]);
    const retrieve = (path, reason) => p.retrieval.push({ ...anchor(path), reason });
    const scopedExpression = (id, contextId) => {
      if (id === null || id === undefined) return;
      if (e.expressions[id]?.contextId !== contextId) throw Error("Expression belongs to another local context");
      add("expressions", id);
    };
    const add = (table, id) => {
      if (id === null || id === undefined) return;
      if (Object.hasOwn(p.evidence[table], id)) return;
      const row = e[table]?.[id];
      if (!row || row.id !== id) throw Error("Missing or inconsistent " + table + " reference: " + id);
      p.evidence[table][id] = structuredClone(row);
      cite(["evidence", table, id], ["evidence", table, id]);
      if (table === "contexts") {
        if (!Array.isArray(row.locals)) throw Error("Ordered local context unavailable");
        const prefix = new Set();
        for (const local of row.locals) {
          if (!local.symbolId || !local.typeExpressionId) throw Error("Incomplete local declaration");
          for (const expressionId of [local.typeExpressionId, local.valueExpressionId]) {
            if (expressionId) checkLocalPrefix(e.expressions[expressionId]?.expression, prefix);
          }
          add("symbols", local.symbolId);
          scopedExpression(local.typeExpressionId, id);
          scopedExpression(local.valueExpressionId, id);
          if (prefix.has(local.symbolId)) throw Error("Duplicate identity in ordered local context");
          prefix.add(local.symbolId);
        }
      } else if (table === "expressions") {
        if (!row.contextId || !row.expression) throw Error("Expression scope unavailable");
        add("contexts", row.contextId);
        walk(row.expression, ["evidence", table, id, "expression"], row.contextId);
      } else if (table === "goalSnapshots") {
        if (!row.goalId || !row.contextId || !row.targetExpressionId) throw Error("Incomplete saved goal state");
        add("goals", row.goalId); add("contexts", row.contextId); scopedExpression(row.targetExpressionId, row.contextId);
      }
    };
    function checkLocalPrefix(node, prefix) {
      if (!node || typeof node !== "object") return;
      if (node.tag === "fvar" && !prefix.has(node.symbolId)) throw Error("Local expression references itself or a later local");
      for (const value of Object.values(node)) if (value && typeof value === "object") checkLocalPrefix(value, prefix);
    }
    function walk(node, path, contextId) {
      if (!node || typeof node !== "object") return;
      if (node.tag === "fvar") {
        add("symbols", node.symbolId);
        if (!e.contexts[contextId].locals.some(l => l.symbolId === node.symbolId)) throw Error("Free variable outside captured context");
      } else if (node.tag === "mvar" && node.goalId) add("goals", node.goalId);
      else if (node.tag === "mvar" && node.universeId) add("universeMetavariables", node.universeId);
      if (node.tag === "const" || node.tag === "proj") {
        p.references.push({ ...anchor(path), kind: node.tag, name: structuredClone(node.name ?? node.typeName), definitionStatus: "unavailable-in-captured-evidence" });
      }
      for (const [key, value] of Object.entries(node)) {
        if (value && typeof value === "object") {
          if (Array.isArray(value)) value.forEach((v, i) => walk(v, [...path, key, i], contextId));
          else walk(value, [...path, key], contextId);
        }
      }
    }
    for (const id of c.occurrenceIds) {
      const r = e.records[id];
      if (!r || r.payloadStatus === "unsupported" || !["tactic", "term"].includes(r.kind))
        throw Error("Selected occurrence payload is unavailable or unsupported");
      add("records", id);
      if (r.kind === "tactic") {
        for (const phase of ["before", "after"]) {
          const ids = r[phase + "GoalSnapshotIds"];
          if (!Array.isArray(ids)) throw Error("Saved goal states unavailable");
          for (const [ordinal, sid] of ids.entries()) {
            const snapshot = e.goalSnapshots[sid];
            if (snapshot?.actionRecordId !== id || snapshot?.phase !== phase || snapshot?.ordinal !== ordinal)
              throw Error("Saved state identity differs from occurrence/phase/order");
            add("goalSnapshots", sid);
          }
        }
      } else if (!r.expressionId || !r.contextId) throw Error("Captured term or its context is unavailable");
      add("contexts", r.contextId); scopedExpression(r.expressionId, r.contextId); scopedExpression(r.expectedTypeId, r.contextId);
      for (const field of ["symbolId", "baseSymbolId"]) add("symbols", r[field]);
      retrieve(["evidence", "records", id], "Original record with parent/child retrieval identities");
    }
    const di = e.declarations.findIndex(d => d.id === c.declarationId);
    if (di < 0) throw Error("Declaration provenance unavailable");
    const d = e.declarations[di];
    const basis = declarationBasis(d);
    if (basis.reason === "Malformed axiom audit metadata.") throw Error(basis.reason);
    p.axiomAudit = {
      scope: "declaration", declarationId: d.id,
      report: structuredClone(d.proofStatus?.axiomAudit ?? { status: "unknown", reason: "Audit not captured" }),
      directValueAdmission: basis.directAdmission,
      meaning: "Reported transitive declaration provenance, not an axiom-use claim about this chunk or absolute truth",
    };
    if (d.proofStatus?.axiomAudit) cite(["evidence", "declarations", di, "proofStatus", "axiomAudit"], ["axiomAudit", "report"]);
    if (typeof d.proofStatus?.containsSorry === "boolean") cite(["evidence", "declarations", di, "proofStatus", "containsSorry"], ["axiomAudit", "directValueAdmission"]);
    retrieve(["evidence", "declarations", di], "Declaration statement, value and provenance; excluded from local closure");
    for (const field of ["capabilities", "captureLimits"]) if (e[field]) cite(["evidence", field], [field]);
    const requiredBytes = contextPacketBytes(p);
    return requiredBytes <= maxBytes ? p : bounded({ ...base, status: "over_limit", requiredBytes, reason: "Complete selected local context exceeds the byte bound; no partial evidence emitted" });
  } catch (error) {
    if (/Byte bound/.test(error.message)) throw error;
    return bounded({ ...base, status: "unavailable", reason: error.message });
  }
}
