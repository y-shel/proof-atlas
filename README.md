# Proof Atlas

A research project for exploring Lean proofs through mechanically extracted structure and revisable explanations.

The goal is to turn a Lean proof into a graph of source actions, subproofs, goals, and formal references. A mathematician and an LLM can use that evidence to compare possible readings, without a preferred solution path. Corrective interventions must rely on a Lean-verified contradiction under explicit assumptions and an agreed formalization of the human claim.

Development starts with small, then medium, LLM-generated proofs. Riemann-scale candidate proof exploration is the long-term target.

No informal proof, blueprint, or author-written synopsis should be required. The Lean project and its dependencies still supply the formal environment.

## Current state

A native Lean JSON evidence exporter, a checked graph projection, and a local Canvas/D3 web explorer. Chat and formal contradiction checking remain future work.

- [Running extraction experiment and observed output](experiments/native-extraction/README.md)

## Export evidence

Install the toolchain pinned in `lean-toolchain`, then run from the repository root:

```sh
python3 scripts/export_evidence.py experiments/native-extraction/Fixtures.lean \
  --declaration repeated --output /tmp/repeated.json
python3 -m unittest discover -s tests -v
```

Repeat `--declaration` to select several declarations in source declaration order. Output includes occurrence paths, source byte ranges, ordered goal snapshots and local contexts, structured expressions, final declaration values, diagnostics, source SHA-256, and Lean version information. Generated free-variable, goal, and universe identities use first encounter order. Natural literals and numeric Name components use decimal strings to preserve their exact values in JavaScript.

The exporter uses only modules in the installed Lean toolchain. Project dependency configuration is unsupported. Selection must have source information in the input file. Elaboration errors, unknown declarations, and expression or universe nesting above 512 fail with a nonzero exit code. Two exports of the same fixtures produce identical bytes.

`captureStatus` describes capture of the advertised capabilities, not proof trust. Assignment witnesses, complete metavariable contexts, metadata contents, and namespace/options snapshots are unavailable or partial. Unsupported information payloads retain occurrence placeholders and children. Local hypothesis presence does not establish premise use, and goal-list disappearance does not establish solving.

Extractor 0.2.0 records `proofStatus.axiomAudit` using public `Lean.collectAxioms` in the final checked environment. A collected audit has sorted structural Lean Names in `axioms` and `containsAdmission` for reachable `sorryAx`; unknown/error audits carry a `reason` and no successful list. The existing `containsSorry` field scans only the declaration value for direct `sorryAx`, not its type or dependencies. Axiom collection includes types and transitive dependencies. It reports provenance under the recorded environment, not absolute truth or proof validity. Legacy unscanned artifacts remain unknown in the browser. The read-only Declaration basis panel keeps this audit separate from local goal hypotheses.

Core-only integration checks cover repeated tactic executions, term-only proofs, local contexts, Unicode byte ranges, shadowed names, large literal fidelity, admission reporting, and explicit failure cases. The original experiment remains runnable.

## Project a proof graph

```sh
python3 scripts/project_graph.py /tmp/repeated.json \
  --source experiments/native-extraction/Fixtures.lean --output /tmp/repeated-graph.json
```

The source bytes must match the evidence SHA-256. The graph includes verified UTF-8
source text, the full evidence artifact, typed nodes and edges, and versioned source-region
groups. IDs are local to the embedded artifact. `project_graph(evidence, source_bytes)`
and `validate_graph(graph, evidence, source_bytes)` are pure Python entry points in
`scripts/project_graph.py`. Validation reconstructs this projection version and rejects
changed witnesses, endpoints, omitted evidence, and altered source labels.

Every structural edge has an evidence path. Reference witnesses point to actual `fvar`
or `const` expression constructors. Constants use structural Lean Names. Local symbols
retain separate context appearances and types. A reference means syntactic occurrence;
it does not establish a necessary premise. Goal identities and snapshots remain separate.

Chunks group source regions by declaration, record kind, syntax kind and exact provenance
and range. Repeated executions share a source group and keep their own occurrence and
state nodes. Groups are a readable view, not execution identities or a unique mathematical
partition. Known structural wrappers and synthetic or missing ranges have
`defaultVisible: false`; they remain in the graph. Unknown source actions stay visible.
Term proofs have term groups. Capability limits and unknown payloads remain explicit.

## Local web explorer

Requires Node 22.12+ and the pinned Lean toolchain used by the native exporter.

```sh
npm install
npm run demo
npm run dev
```

Open the printed local URL, then choose **Open prepared sample** or load a saved
`proof-atlas.graph.v0` JSON file. The sample is regenerated from
`experiments/native-extraction/Fixtures.lean` through the committed native exporter
and graph projector. Generated demo data stays ignored.

The chunk list and canvas show source groups. Links trace recorded containment;
they do not establish mathematical necessity. Selecting a chunk shows original
UTF-8 source bytes after a SHA-256 integrity check, every recorded occurrence,
goal snapshots, ordered local contexts, and typed-edge witnesses. Hidden records
remain available. Imported graphs are not rechecked in Lean by the browser.

```sh
npm run test:web
npm run build
# With the dev server running and Chromium at /sbin/chromium:
node tests/web-browser.mjs
```

The app bundles its dependencies and has no chat, ingestion API, or CDN runtime
requirement. Loading a graph does not upload it. Keep competing readings separate
from extracted facts; this slice supplies evidence inspection only.

Exercise the generated induction/Boolean-branch fixture and its axiom audit locally:

```sh
python3 scripts/export_evidence.py experiments/native-extraction/AxiomAudit.lean --declaration AuditFixture.constructive --declaration AuditFixture.admitted --declaration AuditFixture.viaAdmission --declaration AuditFixture.viaAxioms --declaration AuditFixture.typeDependency --declaration AuditFixture.tallyAppend --output /tmp/axiom-evidence.json
python3 scripts/project_graph.py /tmp/axiom-evidence.json --source experiments/native-extraction/AxiomAudit.lean --output /tmp/axiom-graph.json
```

Open `/tmp/axiom-graph.json` in the local explorer. `tallyAppend` proves two append equations by list induction and Boolean branches, reusing a local equality. Its recorded basis includes `propext` through simplification. The other declarations distinguish an empty basis, direct and reachable admission, arbitrary axioms, and an axiom in a declaration type.

## Selected context packets

The selected-packet panel builds or downloads local evidence for the selected chunk.
It keeps every selected occurrence, input/output snapshot, goal identity, ordered local
context and referenced captured expression. Axiom provenance is explicitly scoped to
the declaration. Other branches and descendant records stay accessible through artifact
IDs and graph-root JSON path arrays. Constant definitions are unavailable in this capture.
Packets contain no proof interpretation.

```sh
node scripts/context_packet.mjs /tmp/repeated-graph.json --list
node scripts/context_packet.mjs /tmp/repeated-graph.json --chunk CHUNK_ID \
  --output /tmp/context.json --max-bytes 131072
npm run test:packets
# With the local explorer running and Chromium at /sbin/chromium:
node tests/context-packet-browser.mjs
```

`web/context-packet.js` exports `buildContextPacket(model, chunkId, {maxBytes})`
for models returned by `loadGraph`, plus `serializeContextPacket` and
`contextPacketBytes`. The CLI validates the complete saved projection before using
the same builder and serializer. Browser packets verify source SHA-256, selected
membership and local reference scopes, without reconstructing the whole graph or
rerunning Lean. This is an integrity check, not proof validity.

The default bound is 128 KiB of canonical UTF-8 JSON, including its final newline.
`ready` includes the complete captured local closure under `selected-local-closure.v0`.
`over_limit` gives the required byte count and retrieval anchors with no partial evidence.
`unavailable` reports missing or unsupported required evidence. A bound too small for
the status envelope fails explicitly. The generated medium fixture's `have shared`
chunk needs about 150 KiB; a 256 KiB bound includes it without changing its boundary.
The selected source fragment is included, rather than the full source or graph.

## Exact evidence retrieval

The explorer lists the selected packet's citations and retrieval entries, including
anchors from an over-limit packet. Choose an anchor and inspect its exact saved
value with a separate byte bound. Inspection leaves chunk selection and graph
camera unchanged. Results clear when the graph, selection or anchor changes.

```sh
node scripts/resolve_evidence.mjs /tmp/repeated-graph.json \
  --anchor /tmp/anchor.json --output /tmp/result.json --max-bytes 131072
node tests/evidence-resolver.test.js
# With a local production preview running:
node tests/evidence-resolver-browser.mjs
```

An anchor is `{"artifactId":"sha256:…","path":["chunks",0]}`. Packet citation
and retrieval objects work directly; their other fields do not affect resolution.
Paths use exact object string keys and numeric array indices. They do not parse
JSONPath, coerce keys, follow inherited properties, or accept prototype keys.

`web/evidence-resolver.js` exports `resolveEvidence(model, anchor, {maxBytes})`,
`serializeEvidenceResult` and `evidenceResultBytes`. It requires a model returned
by `loadGraph` with matching saved artifact identities. The default is 128 KiB.
Ready results contain a detached exact value, citation, scope, capture limits and
capabilities. Null and other scalar values remain available. Over-limit results
report the complete result's required bytes and contain no partial value.
Unavailable results give a reason. All bounds include canonical UTF-8 JSON and
the final newline; a bound too small for the status envelope throws.

The shared result labels the library's `loadGraph` verification tier. Browser
loading does not reconstruct the artifact hash or complete projection semantics.
The CLI additionally validates the complete projection against the same once-read
graph before retrieval and reports that check on stderr. It guards both input
files against output overwrite, including symbolic and hard links. Neither path
replays Lean or adds an interpretation of the proof.
