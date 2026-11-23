import { isVerifiedGraphModel } from "./graph-model.js";
import { serializeContextPacket, contextPacketBytes } from "./context-packet.js";

export const DEFAULT_EVIDENCE_BYTES = 128 * 1024;
export const serializeEvidenceResult = serializeContextPacket;
export const evidenceResultBytes = contextPacketBytes;
const forbidden = new Set(["__proto__", "prototype", "constructor", "*"]);

function isJsonValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) return false;
    for (let i = 0; i < value.length; i++)
      if (!Object.hasOwn(value, i) || !isJsonValue(value[i])) return false;
    return true;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  return Object.values(value).every(isJsonValue);
}

/** Resolve one saved graph value, without computing a closure or interpreting evidence. */
export function resolveEvidence(model, request, { maxBytes = DEFAULT_EVIDENCE_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw Error("Byte bound must be a positive safe integer");
  const object = request && typeof request === "object" && !Array.isArray(request);
  const artifactId = object && Object.hasOwn(request, "artifactId") && typeof request.artifactId === "string" ? request.artifactId : null;
  const path = object && Object.hasOwn(request, "path") && Array.isArray(request.path) ? request.path : null;
  const validPath = path !== null && Array.from(path).every(key =>
    typeof key === "string" ? !forbidden.has(key) :
      typeof key === "number" && Number.isSafeInteger(key) && key >= 0 && !Object.is(key, -0));
  const base = {
    schemaVersion: "proof-atlas.evidence-result.v0",
    citation: { artifactId, path: validPath ? [...path] : null },
  };
  function bounded(result) {
    if (evidenceResultBytes(result) > maxBytes)
      throw Error("Byte bound is too small for the status and exact anchor");
    return result;
  }
  const unavailable = reason => bounded({ ...base, status: "unavailable", reason });
  if (!isVerifiedGraphModel(model)) return unavailable("A model returned by loadGraph is required");
  const g = model.graph;
  if (typeof g.artifactId !== "string" || !/^sha256:[0-9a-f]{64}$/.test(g.artifactId) || g.artifactId !== g.evidence.artifactId)
    return unavailable("Saved graph artifact identity is missing, malformed or inconsistent");
  if (!artifactId || artifactId !== g.artifactId) return unavailable("Artifact identity does not match the loaded graph");
  if (!validPath) return unavailable("Path must contain exact object string keys or nonnegative safe array indices; prototype keys and wildcards are forbidden");
  let value = g;
  for (const key of path) {
    if (!value || typeof value !== "object" ||
        (Array.isArray(value) ? typeof key !== "number" || key >= value.length : typeof key !== "string") ||
        !Object.hasOwn(value, key))
      return unavailable("Exact path is absent or uses the wrong key type");
    value = value[key];
  }
  if (!isJsonValue(value) || !isJsonValue(g.evidence.capabilities ?? null) || !isJsonValue(g.evidence.captureLimits ?? null))
    return unavailable("Requested value or capture metadata is not a saved JSON value");
  const ready = {
    ...base, status: "ready", value,
    scope: { kind: "exact-graph-value", meaning: "Only this saved value. No closure, interpretation, mathematical necessity or exhaustive coverage is inferred." },
    verification: {
      tier: "loadGraph",
      checked: "Source SHA-256, chunk provenance and referenced evidence checked by loadGraph.",
      limits: "Artifact hash and full projection semantics are not reconstructed by this library; Lean is not replayed. The CLI additionally validates the complete saved projection before retrieval.",
    },
    capabilities: g.evidence.capabilities ?? { status: "unknown" },
    captureLimits: g.evidence.captureLimits ?? { status: "unknown" },
  };
  const requiredBytes = evidenceResultBytes(ready);
  if (requiredBytes > maxBytes)
    return bounded({ ...base, status: "over_limit", requiredBytes, reason: "Exact requested value exceeds the byte bound; no partial value emitted" });
  return structuredClone(ready);
}
