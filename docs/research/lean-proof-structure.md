# Deterministic structure extraction for Lean proof exploration

Research date: 2026-11-22. This is a source-grounded feasibility study, not a tested extractor or an approved implementation design. Proposed rules below are engineering recommendations; they have not yet been validated against a corpus.

Follow-up: a [native evidence-reading experiment](../../experiments/native-extraction/README.md) now demonstrates access to tactic records, term records, and final proof expressions on four core Lean fixtures. It does not validate the proposed chunking or graph rules. References below to experiments not yet run concern the corpus comparison and graph validation.

## Recommendation

Use a hybrid of Lean's elaboration information and the resulting proof expressions. Preserve the raw evidence, then derive deterministic, versioned views of it. The default readable chunks should follow source-level proof actions and explicit subproofs; a separate expression view should expose what those actions constructed. Treat automation as an expandable operation whose internal structure is available only to the extent actually recorded.

The crucial distinction is between a graph of what Lean did, a graph of formal term references, and a mathematician's interpretation of why those steps matter. These are related but are not interchangeable. Do not let an LLM create the first two graphs.

## What Lean actually provides

Lean parses commands using an extensible parser, elaborates syntax into core type theory, and checks elaborated results in the kernel. Executable compilation is a later concern. Source syntax can be original, synthetic with positions, or have no source relationship. Command elaboration can execute arbitrary IO. Consequently, native executable or compiler-IR analysis is a poor primary representation of mathematical proof structure, and unconditional reproducibility for arbitrary projects is not justified. [Lean language reference](https://lean-lang.org/doc/reference/latest/Elaboration-and-Compilation/)

`InfoTree` records elaboration information with nested contexts and syntax associations. `TacticInfo` provides before/after goal IDs and metavariable contexts; `TermInfo` associates an expression, expected type, and local context with syntax. Trees can contain holes and deferred assignments. Failed elaboration has explicit partial-information representations. A finalized information tree is valuable evidence but is not itself a mathematical dependency graph. [InfoTree types](https://github.com/leanprover/lean4/blob/master/src/Lean/Elab/InfoTree/Types.lean)

The metavariable context stores declarations and assignments. Tactic goals are represented by metavariables; assignments and delayed assignments require care. Compare states within their own saved contexts, rather than interpreting old goal IDs using only the final context. [Metavariable context implementation](https://github.com/leanprover/lean4/blob/master/src/Lean/MetavarContext.lean)

`Expr` is the representation to inspect for applications, binders, local/free variables, constants, lets, and other core expression forms. Walking these structures establishes syntactic references. It does not establish that a premise is mathematically indispensable, nor reproduce an author's intended explanation. [Expression implementation](https://github.com/leanprover/lean4/blob/master/src/Lean/Expr.lean)

## Approaches and tradeoffs

| Approach | Useful result | Main limitation | Role in proposed system |
| --- | --- | --- | --- |
| Parse Lean syntax with Lean's own frontend | Explicit blocks, nested terms, source spans | Syntax does not expose inferred arguments, actual goal evolution, or all dependencies | Source navigation and chunk boundaries |
| Inspect elaboration `InfoTree` | Tactic state changes and expression-to-source associations | Instrumentation is not a complete trace of every internal reasoning step; overlapping and generated spans | Primary evidence for readable proof actions |
| Traverse elaborated proof `Expr` | Actual formal references and construction structure | Can be enormous, implementation-heavy, and poorly aligned to source actions | Dependency evidence and drilldown |
| Use an existing proof-tree extractor | Faster feasibility spike and reusable rendering ideas | Compatibility, schema, term-proof coverage, and dependency semantics need auditing | Compare Paperproof against a minimal native adapter |

Recommendation: retain all three native evidence layers and make the readable graph a projection. A term-only system loses source intent; a syntax-only system mistakes surface order for logical use; an InfoTree-only system can overclaim what tactic state transitions mean.

## Proposed graph contract

Represent a typed directed multigraph, not an untyped tree. Keep a separate containment hierarchy for nested subproofs. Do not require the union of every edge kind to be acyclic. Formal reference, operational evolution, display order, and containment have different semantics.

Suggested nodes:

- Declaration with statement, complete proof expression reference, imports provenance, and validation status.
- Scope with binders and local-context identity.
- Goal state with target expression and ordered hypotheses in a particular saved context.
- Action with syntax, elaborator identity, before/after snapshots, and nested recorded actions.
- Local fact or term binding with type and optional value.
- External declaration reference with fully qualified name and originating module.
- Subproof group: a view node over evidence, rather than a newly asserted proof fact.

Suggested edges and evidence:

| Edge | Meaning | Required witness |
| --- | --- | --- |
| `contains` | Structural nesting | Syntax or finalized InfoTree path |
| `executes_after` | Recorded operational sequence | Ordered sibling action positions/traversal |
| `has_input_state`, `has_output_state` | Observed state at an action boundary | Saved `TacticInfo` and its context |
| `references_local` | Expression contains a particular local variable | Expression path and resolved local-context entry |
| `references_constant` | Expression contains a named constant | Expression path and constant identity |
| `assigns_goal` | A goal has acquired a recorded assignment | Before/after assignment evidence |
| `depends_on_goal` | A goal assignment contains another metavariable | Expression path in the appropriate assignment context |
| `maps_to_source` | Evidence is associated with source syntax | Source range plus original/synthetic/missing classification |

Do not call every hypothesis present in a goal state a used premise. Do not infer a solved goal merely because it disappeared from the visible goal list: tactics can shelve, reorder, postpone, or otherwise manipulate goals. Keep historical unresolved goal references separately from final instantiated expressions. If a reliable producer-consumer link cannot be reconstructed, expose the observed transition and mark the stronger relationship unknown.

## Proposed chunk rules

1. Select one declaration in its original module environment and finish elaboration before extraction. Preserve diagnostics and unresolved information; never silently render a failed declaration as verified.
2. Create an evidence action for every selected `TacticInfo`, preserving all nested raw records. Choose source-visible actions using original/canonical source spans and containment; distinguish structural combinators from their executed children.
3. A source action can execute multiple times (for example, a combinator applied to multiple goals). Identify each execution separately even when source ranges coincide. A view may group them under a single source action.
4. Establish explicit subproof boundaries from syntax plus elaboration: nested `by` blocks, `have`/`suffices` proofs, case/induction branches, and term constructs such as lambda, let, and match. Exact syntax-kind support is version-specific and needs fixtures.
5. In term-style proofs, use supported syntax/`TermInfo` boundaries and core expressions. Do not force a fake tactic sequence onto an expression proof. Keep an expression fallback when source mapping is absent.
6. Keep `simp`, `aesop`, `omega`, `grind`, custom tactics, and macros as observed operations by default. Show recorded internal actions or proof-term drilldown where available; never invent a human-sized sequence inside a tactic.
7. Optional presentation grouping may combine a maximal chain of actions only when it has a single continuing goal, stays inside one scope, and crosses no explicit subproof, branching, introduced reusable fact, or unresolved evidence boundary. Preserve original actions and expose grouping policy/version. A size threshold is a display preference, not a mathematical definition.
8. Never make character count, token count, or LLM judgment the authoritative structural partition. Those can create temporary context windows or suggested reading groups over a fixed graph.

These rules aim for reproducible boundaries, not a claim that every mathematical idea has a unique formal chunk. Nested groups can overlap in their semantic content; the evidence representation must survive changing the presentation policy.

## Identity, determinism, and honest guarantees

Proposed guarantee: identical captured evidence plus the same canonicalization and chunk-policy versions yields identical serialized graph content. Separately measure whether repeated extraction from the same pinned project yields identical evidence. This is weaker and more defensible than guaranteeing deterministic elaboration for all Lean code.

Record source hashes, Lean toolchain, package revisions/manifest, project options, extractor build, environment configuration relevant to IO, and resource limits. Reject or explicitly mark incomplete runs. Re-elaboration should run in an isolated worker with bounded resources because project elaborators are executable code.

Canonicalize generated metavariable/free-variable IDs by first occurrence within a deterministic traversal, preserving aliases and context boundaries. Preserve binder scopes, expression paths, universe information, and sharing. Sort sets/maps where ordering has no semantics; retain goal and action order where it does. Keep generated raw IDs only as diagnostic data.

Use snapshot-local IDs from the artifact fingerprint plus structural paths and occurrence indexes. Content hashes may help deduplication, but identical expressions in different scopes/actions must not collapse into one semantic node. Cross-edit matching is a separate, fallible feature; never promise that a stable hash proves unchanged mathematical meaning. Pretty-printed text is display data, not the canonical identity of an expression.

## Existing systems worth inspecting

**Paperproof** is the closest starting point for visual proof structure. It visualizes goal/hypothesis evolution and documents tactic-proof coverage. Its terminal extractor accepts a Lean file, constant name, and output path and serializes steps/goals as JSON. That makes it a concrete spike candidate, not proof that its current graph satisfies all proposed dependency guarantees. Audit source mapping, repeated actions, dependency calculation, and term-proof support before adopting its schema. [Paperproof](https://github.com/Paper-Proof/paperproof), [terminal extractor source](https://github.com/Paper-Proof/paperproof/blob/main/lean/terminal.lean)

**LeanDojo** demonstrates extraction of command ASTs, tactic traces with before/after states and spans, and premise information. Its original repository now explicitly marks the library deprecated in favor of LeanDojo-v2. Do not adopt the old library by default merely because older research used it. Inspect v2 against the target Lean toolchain before choosing it. [Original extraction source](https://github.com/lean-dojo/LeanDojo/blob/main/src/lean_dojo/data_extraction/ExtractData.lean), [deprecation notice](https://github.com/lean-dojo/LeanDojo), [LeanDojo-v2](https://github.com/lean-dojo/LeanDojo-v2)

**Pantograph** provides programmatic frontend interaction, proof execution, expression construction, and environment inspection. It is a candidate for interactive follow-up queries or isolated proof experiments. That capability should be distinguished from passive extraction of a complete historical execution graph. [Pantograph](https://github.com/leanprover/Pantograph)

**ProofWidgets4** provides Lean-integrated UI components, symbolic displays, custom expression displays, and interactive proving loops. It is relevant if the explorer should also live inside the Lean infoview. Its README recommends release tags for toolchain compatibility. A standalone web application still needs a persistent graph API and its own application state. [ProofWidgets4](https://github.com/leanprover-community/ProofWidgets4)

**LeanArchitect** extracts blueprint data using explicit annotations/docstrings and infers declaration dependencies from constants. Its annotation-driven workflow does not meet the requirement of discovering subproof chunks without author-supplied narrative, but it is useful prior art for statement-versus-proof dependency distinctions and optional export. [LeanArchitect](https://github.com/hanwenzhu/LeanArchitect)

## What “without metadata” can mean

No theorem synopsis, blueprint annotations, author-supplied chunk labels, or informal proof should be needed. But a Lean fragment alone may not determine its meaning: imports, preceding declarations, notation, namespaces, instances, and the matching toolchain are part of the formal input. Compiler-generated elaboration information is exactly the evidence to exploit; it should not be excluded under the phrase “no metadata.”

The explanatory system can infer a plausible reading without knowing the theorem's history. It cannot recover a uniquely correct author's intent from a proof artifact. Names may offer clues but are not validation. A useful evaluation includes identifier-obfuscated examples to see whether the model is actually reading states and expressions.

## Small experiments before committing to implementation

Run the same hand-audited corpus through Paperproof's terminal output and a minimal native InfoTree/Expr adapter. Compare coverage, source traceability, graph size, repeated-run canonical equality, and extractor effort. No such run has been performed in this research.

Corpus should include direct `exact`, lambda/application-only term proofs, `have` reused twice, unused hypotheses, `suffices`, induction with dependent hypotheses, nested cases, `constructor`, `<;>`, `all_goals`, goal reordering, `try`/`first` backtracking, `calc`, rewriting at hypotheses, `simp`, automation, a custom macro, generated syntax with no span, Unicode source positions, and a deliberately incomplete proof. Include both core Lean examples and a pinned mathlib sample; include a large automation-generated expression as a resource test.

Require hand-checked edge witnesses, scope correctness, explicit incomplete status, and no invented dependency edges. Measure source-action coverage separately from internal-proof coverage. Measure graph reproducibility separately from whether explanations sound convincing. An honest coarse automation node is preferable to a detailed but unsupported graph.

Open empirical questions: how much internal structure specific automation tactics retain; which finalized InfoTree API is best for the chosen Lean version; whether dependency assignments can be attributed to individual nested actions without ambiguity; how Paperproof handles each adversarial fixture; and how large proof expressions can be explored without materializing their full expansion in the browser.
