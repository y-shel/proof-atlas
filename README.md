# Proof Atlas

A research project for exploring Lean proofs through mechanically extracted structure and revisable explanations.

The goal is to turn a Lean proof into a graph of source actions, subproofs, goals, and formal references. An LLM explains individual chunks from their local formal context, then uses the graph to suggest a larger story. A mathematician can question, annotate, and refine that story while inspecting the evidence.

No informal proof, blueprint, or author-written synopsis should be required. The Lean project and its dependencies still supply the formal environment.

## Current state

A native Lean JSON evidence exporter, a checked graph projection, and an earlier text inspection experiment. No web application is implemented.

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

`captureStatus` describes capture of the advertised capabilities, not proof trust. Assignment witnesses, complete metavariable contexts, metadata contents, namespace/options snapshots, and transitive axiom scans are unavailable or partial. Unsupported information payloads retain occurrence placeholders and children. Direct `sorryAx` occurrences are reported separately from diagnostics. Local hypothesis presence does not establish premise use, and goal-list disappearance does not establish solving.

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
