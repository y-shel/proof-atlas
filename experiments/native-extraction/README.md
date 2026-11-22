# Native extraction experiment

This throwaway experiment tests whether Lean's frontend exposes source-associated tactic records, term records, and final proof expressions without a human proof description. It uses core Lean proofs and no third-party packages. It is not the application or a dependency-graph implementation.

## Run

From the repository root, use the installed toolchain:

```bash
lean +leanprover/lean4:v4.30.0-rc2 --run experiments/native-extraction/Inspect.lean
```

The command accepts an optional fixture file path. The four declaration names in the report are fixed to the supplied fixtures. The command elaborates the file and fails on elaboration errors. It does not invoke a model or download packages. `observed.txt` records an actual run on 2026-11-22.

## What the experiment tests

`Fixtures.lean` contains a nested `have` proof, constructor branches, a term-only lambda proof, and a tactic applied to both goals through `<;>`.

`Inspect.lean` calls `Lean.Elab.IO.processCommands` and reads the completed command snapshots. It traverses their information trees with merged contexts. It prints source byte ranges, syntax kinds, before/after goal IDs, and input target types for tactic records. It counts term records by declaration and reads final theorem expressions from the environment.

The prototype's data consists of Lean's existing `InfoTree`, `ContextInfo`, `TacticInfo`, and theorem `Expr` objects, plus counts. It does not define a new product graph schema.

## Observations

The retained run exited successfully. It reported 59 tactic records, 114 term records, and zero unresolved InfoTree holes. Term records attributed to `localFact`, `branches`, `termOnly`, and `repeated` numbered 33, 25, 30, and 18 respectively. The total includes records outside those declaration contexts. These are raw instrumentation counts, not chunk counts or coverage percentages.

The output demonstrates access to both elaboration records and final expressions. The tactic tree includes structural wrappers and generated tactic actions. A tactic record is not necessarily a single source action or a useful explanation chunk.

The repeated `exact hp` action has the same source range for two executions and different input goal IDs. Source ranges alone cannot identify an execution. The constructor proof and the term-only proof produce the same displayed expression structure after their binders. Source-level evidence preserves distinctions that the final expression display loses.

Goal targets must be printed inside each goal's local context and its saved metavariable context. Otherwise this experiment prints internal free-variable names in place of the source variable names.

An earlier version read only the final state from the older synchronous `Frontend.processCommands` loop. That state had no tactic or term records after the terminal command, although final proof expressions remained accessible. The retained version uses `Lean.Elab.IO.processCommands`, which collects the top-level command snapshots. A per-command capture loop also produced records in a scratch run. These observations concern this exact Lean release.

## Limits

This run does not establish dependency-edge correctness, canonical IDs, determinism across executions, extraction coverage outside these fixtures, or compatibility with other Lean releases. Raw goal IDs are debugging identifiers. The output is a text report, not a stable serialization format.

No automatic chunk selection has been attempted. The next extraction question is how to preserve all raw records while selecting readable source actions without merging distinct executions. Automation, failed elaboration, custom macros, synthetic source positions, and large proofs need separate experiments.

The test resolves finalized command snapshots. It counts unresolved InfoTree holes but does not attempt to repair any. A missing source range would remain visible as `none`. The fixture and extractor are trusted local code; this script does not isolate untrusted Lean elaborators.
