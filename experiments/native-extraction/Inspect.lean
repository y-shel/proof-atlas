import Lean

open Lean Elab

def names (gs : List MVarId) : String :=
  String.intercalate "," (gs.map fun g => g.name.toString)

structure Counts where
  tactics : Nat := 0
  terms : Nat := 0
  holes : Nat := 0
  termDecls : List Name := []
  deriving Repr

partial def visit (tree : InfoTree) (ctx : Option ContextInfo) : StateT Counts IO Unit := do
  match tree with
  | .context c t => visit t (c.mergeIntoOuter? ctx)
  | .hole _ => modify fun s => { s with holes := s.holes + 1 }
  | .node i children =>
    match i with
    | .ofTacticInfo ti =>
      modify fun s => { s with tactics := s.tactics + 1 }
      let decl := ctx.bind (·.parentDecl?)
      let span := s!"{ti.stx.getPos?}-{ti.stx.getTailPos?}"
      IO.println s!"tactic decl={decl} kind={ti.stx.getKind} span={span} before=[{names ti.goalsBefore}] after=[{names ti.goalsAfter}]"
      if let some c := ctx then
        let targets ← { c with mctx := ti.mctxBefore }.runMetaM {} do
          ti.goalsBefore.mapM fun (g : MVarId) => do
            g.withContext do return (← Meta.ppExpr (← g.getType)).pretty
        IO.println s!"  input-targets={targets}"
    | .ofTermInfo _ =>
      modify fun s => { s with
        terms := s.terms + 1
        termDecls := ((ctx.bind (·.parentDecl?)).toList ++ s.termDecls) }
    | _ => pure ()
    for child in children do visit child ctx

unsafe def main (args : List String) : IO Unit := do
  let path := args.headD "experiments/native-extraction/Fixtures.lean"
  initSearchPath (← findSysroot)
  enableInitializersExecution
  let input ← IO.FS.readFile path
  let ictx := Parser.mkInputContext input path
  let (header, ps, msgs) ← Parser.parseHeader ictx
  let (env, msgs) ← processHeader header {} msgs ictx
  let opts := Elab.async.set {} false
  let final ← Lean.Elab.IO.processCommands ictx ps (Command.mkState env msgs opts)
  for msg in final.commandState.messages.toList do
    IO.println s!"diagnostic {← msg.toString}"
  if final.commandState.messages.hasErrors then
    throw (IO.userError "Fixture elaboration failed")
  let walk : StateT Counts IO Unit := do
    for tree in final.commandState.infoState.trees do visit tree none
  let (_, counts) ← walk.run {}
  IO.println s!"counts tactics={counts.tactics} terms={counts.terms} holes={counts.holes}"
  for decl in [`localFact, `branches, `termOnly, `repeated] do
    IO.println s!"term-records decl={decl} count={(counts.termDecls.filter (· == decl)).length}"
    if let some (.thmInfo ci) := final.commandState.env.find? decl then
      IO.println s!"proof decl={decl} expr={ci.value}"
