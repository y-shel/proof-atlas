# Proof Atlas

A research project for exploring Lean proofs through mechanically extracted structure and revisable explanations.

The goal is to turn a Lean proof into a graph of source actions, subproofs, goals, and formal references. An LLM explains individual chunks from their local formal context, then uses the graph to suggest a larger story. A mathematician can question, annotate, and refine that story while inspecting the evidence.

No informal proof, blueprint, or author-written synopsis should be required. The Lean project and its dependencies still supply the formal environment.

## Current state

Research and an experimental Lean evidence reader. No graph extractor or web application has been implemented yet.

- [Lean extraction research](docs/research/lean-proof-structure.md)
- [Explanation and web explorer proposal](docs/research/proof-atlas.md)
- [Running extraction experiment and observed output](experiments/native-extraction/README.md)

The proposed first experiment compares Paperproof's terminal extractor with a small native Lean adapter on a hand-audited corpus before choosing the extraction foundation.
