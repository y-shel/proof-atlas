const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const verifiedModels = new WeakSet();
export const isVerifiedGraphModel = (model) => verifiedModels.has(model);
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export async function loadGraph(input) {
  const g = structuredClone(input);
  if (g?.schemaVersion !== "proof-atlas.graph.v0")
    throw Error("Unsupported graph schema");
  if (
    !Array.isArray(g.chunks) ||
    !Array.isArray(g.edges) ||
    !g.nodes ||
    !g.evidence?.records ||
    !Array.isArray(g.evidence.declarations) ||
    typeof g.source?.text !== "string"
  )
    throw Error("Missing graph tables");
  for (const table of ["records", "goalSnapshots", "contexts", "expressions"]) {
    const value = g.evidence[table];
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error("Missing evidence table: " + table);
  }
  if (!g.evidence.declarations.every((d) => typeof d?.id === "string"))
    throw Error("Invalid declarations");
  for (const record of Object.values(g.evidence.records)) {
    if (!record || typeof record !== "object")
      throw Error("Invalid execution record");
    for (const phase of ["before", "after"]) {
      const ids = record[phase + "GoalSnapshotIds"];
      if (
        ids !== undefined &&
        (!Array.isArray(ids) ||
          !ids.every((id) => Object.hasOwn(g.evidence.goalSnapshots, id)))
      )
        throw Error("Invalid snapshot reference");
    }
  }
  for (const snapshot of Object.values(g.evidence.goalSnapshots)) {
    if (
      !snapshot ||
      !Object.hasOwn(g.evidence.expressions, snapshot.targetExpressionId) ||
      !Object.hasOwn(g.evidence.contexts, snapshot.contextId)
    )
      throw Error("Invalid snapshot context or target");
  }
  const ref = (table, id) => {
    if (
      id !== null &&
      id !== undefined &&
      (typeof id !== "string" ||
        !Object.hasOwn(g.evidence[table], id) ||
        !g.evidence[table][id] ||
        typeof g.evidence[table][id] !== "object")
    )
      throw Error("Invalid " + table + " reference");
  };
  for (const context of Object.values(g.evidence.contexts)) {
    if (!context || !Array.isArray(context.locals))
      throw Error("Invalid context locals");
    for (const local of context.locals) {
      if (!local || typeof local !== "object")
        throw Error("Invalid context local");
      ref("expressions", local.typeExpressionId);
      ref("expressions", local.valueExpressionId);
    }
  }
  for (const record of Object.values(g.evidence.records)) {
    ref("contexts", record.contextId);
    ref("expressions", record.expressionId);
    ref("expressions", record.expectedTypeId);
    if (
      record.kind === "tactic" &&
      (!Array.isArray(record.beforeGoalSnapshotIds) ||
        !Array.isArray(record.afterGoalSnapshotIds))
    )
      throw Error("Invalid tactic snapshot arrays");
  }
  const bytes = encoder.encode(g.source.text);
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  if (
    hash !== g.source.sourceSha256 ||
    bytes.length !== g.source.sourceByteLength ||
    hash !== g.evidence.project?.sourceSha256 ||
    bytes.length !== g.evidence.project?.sourceByteLength
  )
    throw Error("Source bytes do not match recorded SHA-256 and length");
  const ids = new Set();
  for (const c of g.chunks) {
    if (
      !c ||
      !["tactic", "term"].includes(c.kind) ||
      (c.syntaxKind !== null && typeof c.syntaxKind !== "string") ||
      (c.text !== null && typeof c.text !== "string") ||
      typeof c.defaultVisible !== "boolean" ||
      typeof c.declarationId !== "string" ||
      !g.evidence.declarations.some((d) => d.id === c.declarationId) ||
      !c.source ||
      !["original", "synthetic", "missing"].includes(c.source.classification)
    )
      throw Error("Invalid chunk label or provenance types");

    if (
      typeof c.id !== "string" ||
      ids.has(c.id) ||
      !Array.isArray(c.occurrenceIds) ||
      c.occurrenceIds.length === 0 ||
      !c.occurrenceIds.every((id) => Object.hasOwn(g.evidence.records, id))
    )
      throw Error("Invalid chunk occurrences");
    for (const id of c.occurrenceIds) {
      const record = g.evidence.records[id];
      if (
        record.declarationId !== c.declarationId ||
        (record.kind === "partialTerm" ? "term" : record.kind) !== c.kind ||
        record.syntaxKind !== c.syntaxKind ||
        !c.source ||
        !record.source ||
        ["classification", "startByte", "endByte"].some(
          (key) => c.source[key] !== record.source[key],
        )
      )
        throw Error("Chunk provenance differs from its execution");
    }
    const span = c.source;
    let text = null;
    if (span?.startByte !== null && span?.startByte !== undefined) {
      if (
        !Number.isInteger(span.startByte) ||
        !Number.isInteger(span.endByte) ||
        span.startByte < 0 ||
        span.endByte < span.startByte ||
        span.endByte > bytes.length
      )
        throw Error("Invalid chunk source range");
      try {
        text = decoder.decode(bytes.slice(span.startByte, span.endByte));
      } catch {
        throw Error("Invalid chunk UTF-8 range");
      }
    }
    if (c.text !== text) throw Error("Chunk text differs from source bytes");
    ids.add(c.id);
  }
  for (const e of g.edges)
    if (
      !g.nodes[e.source] ||
      !g.nodes[e.target] ||
      !Array.isArray(e.witness?.path)
    )
      throw Error("Invalid edge endpoints or witness");
  for (const e of g.edges) {
    const value = witnessValue({ graph: g }, e);
    if (e.kind === "contains") {
      const path = e.witness.path;
      if (
        path.length !== 4 ||
        path[0] !== "records" ||
        path[2] !== "childIds" ||
        !Number.isInteger(path[3]) ||
        e.source !== "occurrence:" + path[1] ||
        e.target !== "occurrence:" + value ||
        !Object.hasOwn(g.evidence.records, value)
      )
        throw Error("Invalid containment witness");
    }
  }
  freeze(g);
  const model = Object.freeze({
    graph: g,
    declarations: g.evidence.declarations,
    chunks: (id, hidden = false) =>
      g.chunks.filter(
        (c) => c.declarationId === id && (hidden || c.defaultVisible),
      ),
  });
  verifiedModels.add(model);
  return model;
}
export function sourceParts(m, c) {
  const s = c?.source;
  if (
    s?.classification !== "original" ||
    !Number.isInteger(s.startByte) ||
    !Number.isInteger(s.endByte)
  )
    return null;
  const bytes = encoder.encode(m.graph.source.text);
  if (s.startByte < 0 || s.endByte < s.startByte || s.endByte > bytes.length)
    return null;
  try {
    return [
      decoder.decode(bytes.slice(0, s.startByte)),
      decoder.decode(bytes.slice(s.startByte, s.endByte)),
      decoder.decode(bytes.slice(s.endByte)),
    ];
  } catch {
    return null;
  }
}
export function witnessValue(m, e) {
  let v = m.graph.evidence;
  for (const key of e.witness.path) {
    if (!v || typeof v !== "object" || !Object.hasOwn(v, key))
      throw Error("Unresolved witness path");
    v = v[key];
  }
  return v;
}
export function overview(m, id, hidden = false) {
  const chunks = m.chunks(id, hidden);
  const owner = new Map();
  for (const c of chunks)
    for (const o of c.occurrenceIds) owner.set("occurrence:" + o, c.id);
  const outgoing = new Map();
  for (const e of m.graph.edges)
    if (e.kind === "contains") {
      if (!outgoing.has(e.source)) outgoing.set(e.source, []);
      outgoing.get(e.source).push(e);
    }
  const links = [];
  const seen = new Set();
  for (const c of chunks)
    for (const o of c.occurrenceIds) {
      const stack = [{ node: "occurrence:" + o, path: [], visited: new Set() }];
      while (stack.length) {
        const p = stack.pop();
        if (p.visited.has(p.node)) continue;
        const visited = new Set(p.visited).add(p.node);
        for (const e of outgoing.get(p.node) || []) {
          const path = [...p.path, e],
            target = owner.get(e.target);
          if (target && target !== c.id) {
            const key = c.id + "|" + target;
            if (!seen.has(key)) {
              links.push({ source: c.id, target, edges: path });
              seen.add(key);
            }
          } else stack.push({ node: e.target, path, visited });
        }
      }
    }
  return {
    nodes: chunks.map((c) => ({
      id: c.id,
      label: c.text || c.syntaxKind || c.kind,
      chunk: c,
    })),
    links,
  };
}

// Match Lean.Name.cmp. Numeric components retain exact decimal values.
function axiomNameKey(name) {
  if (!name || typeof name !== "object" || Array.isArray(name)) throw Error();
  if (name.tag === "anonymous" && Object.keys(name).length === 1) return [0];
  if (!["str", "num"].includes(name.tag) ||
      Object.keys(name).sort().join() !== "parent,tag,value" ||
      typeof name.value !== "string") throw Error();
  if (name.tag === "num" && !/^(0|[1-9][0-9]*)$/.test(name.value)) throw Error();
  return [name.tag === "num" ? 1 : 2, axiomNameKey(name.parent),
    name.tag === "num" ? BigInt(name.value) : name.value];
}
function compareNameStrings(a, b) {
  const left = Array.from(a, c => c.codePointAt(0));
  const right = Array.from(b, c => c.codePointAt(0));
  for (let i = 0; i < Math.min(left.length, right.length); i++)
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return left.length - right.length;
}
function compareAxiomNames(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[0] === 0) return 0;
  const parent = compareAxiomNames(a[1], b[1]);
  return parent || (a[0] === 2 ? compareNameStrings(a[2], b[2]) :
    a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);
}
export function declarationBasis(declaration) {
  const proof = declaration?.proofStatus;
  const directAdmission = typeof proof?.containsSorry === "boolean" ? proof.containsSorry : null;
  const unavailable = (status, reason) => ({
    status, reason, axioms: null, containsAdmission: null, directAdmission,
  });
  if (!proof || !Object.hasOwn(proof, "axiomAudit"))
    return unavailable("unknown", "No recorded axiom audit. Legacy captures may be unscanned.");
  const audit = proof.axiomAudit;
  try {
    if (!audit || typeof audit !== "object" || Array.isArray(audit)) throw Error();
    if (["unknown", "error"].includes(audit.status)) {
      if (Object.keys(audit).sort().join() !== "reason,status" ||
          typeof audit.reason !== "string" || !audit.reason.trim()) throw Error();
      return unavailable(audit.status, audit.reason);
    }
    if (audit.status !== "collected" ||
        Object.keys(audit).sort().join() !== "axioms,containsAdmission,status" ||
        !Array.isArray(audit.axioms) || typeof audit.containsAdmission !== "boolean") throw Error();
    const keys = audit.axioms.map(axiomNameKey);
    if (keys.some((key, i) => i > 0 && compareAxiomNames(keys[i-1], key) >= 0)) throw Error();
    const reached = audit.axioms.some(n => n.tag === "str" && n.value === "sorryAx" && n.parent.tag === "anonymous");
    if (reached !== audit.containsAdmission) throw Error();
    return { status: "collected", axioms: audit.axioms,
      containsAdmission: audit.containsAdmission, directAdmission };
  } catch {
    return unavailable("error", "Malformed axiom audit metadata.");
  }
}
