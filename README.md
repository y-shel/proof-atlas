# Proof Atlas

A research project for exploring Lean proofs through mechanically extracted structure and revisable explanations.

The goal is to turn a Lean proof into a graph of source actions, subproofs, goals, and formal references. An LLM explains individual chunks from their local formal context, then uses the graph to suggest a larger story. A mathematician can question, annotate, and refine that story while inspecting the evidence.

No informal proof, blueprint, or author-written synopsis should be required. The Lean project and its dependencies still supply the formal environment.

## Current state

A native Lean JSON evidence exporter and an earlier text inspection experiment. No graph projection or web application is implemented.

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
