# Proof Atlas: explanations over a formal evidence graph

Research date: 2026-11-22. This document records the user's goals and a proposed direction. It is not an approved implementation design. The technical extraction study is in [lean-proof-structure.md](lean-proof-structure.md).

Follow-up: a [native evidence-reading experiment](../../experiments/native-extraction/README.md) has run on four core fixtures. It establishes access to elaboration records and proof expressions, but no graph or UI has been built.

## User intent

Give a mathematician tools to solve the riddle of an unfamiliar Lean proof. Discover chunks and their relationships mechanically. Explain each chunk from its local context, assemble a graph-informed narrative, and let the mathematician refine its meaning with an LLM. Structure must be robust even when the mathematical interpretation is tentative. Require no supplied informal proof or narrative metadata.

## Research conclusion

The project is plausible, but there are two separate tasks: extracting defensible evidence and interpreting it. Neither a source AST nor a kernel term alone provides a unique partition into mathematical ideas. The strongest proposed approach combines source boundaries, elaboration history, and proof-expression references, keeping their provenance visible. See the extraction study for primary sources and limits.

Existing work makes a focused feasibility experiment practical. Paperproof already visualizes changes to goals and hypotheses. Lean Blueprint supplies useful narrative/dependency navigation precedent, but its authored blueprint workflow does not meet automatic chunk discovery. These are separate kinds of prior art. [Paperproof](https://github.com/Paper-Proof/paperproof), [Lean Blueprint](https://github.com/PatrickMassot/leanblueprint)

## Three feasible approaches

| Approach | Advantage | Tradeoff |
| --- | --- | --- |
| Adapt Paperproof's extractor | Existing goal-history extraction and visual precedent | Must audit term proofs, edge semantics, repeated tactics, and version compatibility |
| Native Lean evidence exporter | Explicit control over provenance, chunk policy, and term views | More initial work and ongoing toolchain compatibility work |
| Start with syntax-only browsing | Cheap source navigation without successful elaboration | Cannot support strong claims about logical dependencies; suitable only as a marked fallback |

Recommendation: compare the first two on the same small corpus before selecting one. Retain syntax browsing as a degraded mode. This is a recommendation, not a choice already made by the user.

## Proposed separation of records

1. **Evidence artifact:** immutable extraction snapshot, source locations, expression references, saved contexts, diagnostics, and edge witnesses.
2. **Display projection:** versioned grouping and filtering of evidence into readable chunks. Every displayed group expands back to evidence IDs.
3. **Interpretation records:** model explanations, competing readings, questions, human corrections, and synthesized narratives. Each cites the artifact and relevant evidence IDs.

An interpretation may suggest a grouping or relationship. Store that suggestion as interpretation; a conversation must never silently rewrite the mechanically extracted graph. A new Lean revision produces a new evidence artifact and explicit stale interpretation status.

## Local explanation contract

Independent explanation should mean independent of a guessed global narrative, rather than deprived of the information needed to understand the step. Give the model:

- The chunk's source and its statement or before/after goals.
- Its local binders, hypotheses, and relevant definitions or referenced declaration signatures.
- Recorded formal dependencies and explicit limits on extraction coverage.
- A request for a literal account of what changes, a tentative mathematical reading, and unresolved questions.

Do not give first-pass node explanations the theorem's global story or earlier speculative labels. Names and types remain useful formal input; assess dependence on suggestive names with renamed fixtures. If a chunk needs an external definition, retrieve it by a formal reference rather than ask the model to guess.

Suggested output fields: `artifactId`, `nodeIds`, `literalEffect`, `possibleMeaning`, `evidenceRefs`, `unknowns`, `modelAndPromptVersion`. Distinguish grounded claims from interpretations; avoid presenting model confidence as a calibrated probability.

Local formal context may be large. Select the chunk's actual references first, then retrieve definitions on demand with explicit truncation. Cache explanations by evidence, included definition hashes, and prompt/model version. A changed interpretation invalidates affected narrative summaries, not the formal graph.

## Graph-aware synthesis and collaboration

Assemble explanations along actual dependency relationships, preserving branches and shared facts. Summarize nested groups before requesting an overview. The narrative should describe alternative cases as cases rather than force every node into a linear chain. Every substantive statement links back to supporting nodes.

Chat operates on a selected node, subgraph, or the overview. The model can request adjacent states, upstream formal references, source, and saved annotations. It should distinguish a mechanical question such as “what term references this fact?” from an interpretive one such as “why introduce this invariant?”

The mathematician can rename a display group, flag a mistaken interpretation, pin a reading, compare alternatives, and ask what remains unexplained. Store authorship and revision history. A human-approved explanation is still an interpretation; a formal claim needs Lean evidence or a separately checked Lean result.

For large proofs, retrieve subgraphs and hierarchical summaries rather than sending the entire project to every call. Generate explanations lazily on selection, with an optional batch queue and cancellation. This bounds model usage and keeps the first useful interaction fast.

## Proposed web explorer

Use a source pane, a central graph, and an explanation/chat pane. Selecting a node highlights its source, incoming references, local context, and explanation. Clicking an edge shows its kind and evidence witness. Offer a text/list navigation equivalent to the canvas.

Default to source-visible actions and collapsed subproofs. Expose term internals on demand. Filters should distinguish containment, operational order, formal references, and interpretive links. Indicate failed, partial, stale, and unavailable extraction states in text. Do not label every visible arrow a logical dependency.

React Flow supports custom React node content, a useful fit for proof cards with controls. Cytoscape.js offers graph analysis and compound-node support. Choose between them after testing representative proof sizes and interaction needs, rather than assume either handles an arbitrary full proof term smoothly. [React Flow custom nodes](https://reactflow.dev/learn/customization/custom-nodes), [Cytoscape.js documentation](https://js.cytoscape.org/)

Lean4web is relevant precedent for a browser Lean editor, and ProofWidgets for Lean-integrated interactive displays. Neither removes the need for the proposed persistent graph and interpretation records. [Lean4web](https://github.com/leanprover-community/lean4web), [ProofWidgets4](https://github.com/leanprover-community/ProofWidgets4)

An initial deployment could keep Lean extraction in a local worker and serve a web client over its artifact API. Rendering a saved artifact should not require a live Lean process. Running an imported Lean project does require executing project code, so extraction workers need an isolated environment and resource bounds. Keep LLM credentials on the server side.

## Suggested feasibility experiment

Before building the full app, extract a few small proofs covering term style, reusable `have`, branches, induction, combinators, automation, unused hypotheses, and incomplete proofs. Compare Paperproof output against a minimal native exporter. Preserve the exact project/toolchain revisions and export artifacts for manual inspection.

The decision should follow evidence: Can every claimed edge be justified? Are scopes and repeated actions distinct? Does the same captured evidence yield the same canonical graph? Can the renderer expose partial information honestly? Does a mathematician find the local explanations useful without a supplied synopsis?

Then build one vertical slice: select a declaration, view chunks and witnesses, explain a selected node, correct its interpretation, and regenerate a cited overview. Defer project-wide batch explanations until this interaction works.

## Evaluation and remaining questions

Evaluate graph correctness separately from explanation quality. Audit edge witnesses and source coverage by hand; measure reproducibility and graph size on pinned inputs. For explanations, ask mathematicians to identify unsupported claims, correct local meanings, and reconstruct an overview with and without the tool. Include misleading names, missing context, and large automation nodes.

Unsettled product choices include the first target proof corpus, whether editing Lean belongs in the first app, and local versus hosted use. The most consequential technical unknown is extraction coverage and attribution inside real custom tactics. No extractor comparison, usability test, or web prototype has been run in this research.
