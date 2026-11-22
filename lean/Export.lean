import Lean

open Lean Elab
namespace ProofAtlas

def obj := Json.mkObj
def str := Json.str
def nat (n : Nat) : Json := toJson n
def arr (xs : Array Json) : Json := Json.arr xs

def nameJson : Name → Json
  | .anonymous => obj [("tag", str "anonymous")]
  | .str p s => obj [("tag", str "str"), ("parent", nameJson p), ("value", str s)]
  | .num p n => obj [("tag", str "num"), ("parent", nameJson p), ("value", str (toString n))]

structure Capture where
  records : Array Json := #[]
  contexts : Array Json := #[]
  expressions : Array Json := #[]
  snapshots : Array Json := #[]
  symbols : Array Name := #[]
  goals : Array Name := #[]
  roots : Array Json := #[]
  universes : Array Name := #[]
  deriving Inhabited

abbrev CaptureM := StateT Capture IO

def symbol (n : Name) (goal := false) : CaptureM String := do
  let s ← get
  let ns := if goal then s.goals else s.symbols
  let i := (ns.toList.idxOf? n).getD ns.size
  if i == ns.size then
    if goal then modify fun s => {s with goals := s.goals.push n}
    else modify fun s => {s with symbols := s.symbols.push n}
  return (if goal then "g" else "v") ++ toString i

partial def levelJson (l : Level) (depth : Nat := 0) : CaptureM Json := do
  if depth > 512 then throw (IO.userError "Universe traversal depth exceeds capture limit 512")
  match l with
  | .zero => return obj [("tag", str "zero")]
  | .succ l => return obj [("tag", str "succ"), ("level", ← levelJson l (depth+1))]
  | .max a b => return obj [("tag", str "max"), ("left", ← levelJson a (depth+1)), ("right", ← levelJson b (depth+1))]
  | .imax a b => return obj [("tag", str "imax"), ("left", ← levelJson a (depth+1)), ("right", ← levelJson b (depth+1))]
  | .param n => return obj [("tag", str "param"), ("name", nameJson n)]
  | .mvar n =>
    let ns := (← get).universes
    let i := (ns.toList.idxOf? n.name).getD ns.size
    if i == ns.size then modify fun s => {s with universes := s.universes.push n.name}
    return obj [("tag", str "mvar"), ("universeId", str ("u" ++ toString i))]

partial def encodeExpr (e : Expr) (depth : Nat := 0) (traversalDepth : Nat := 0) : CaptureM Json := do
  if traversalDepth > 512 then throw (IO.userError "Expression traversal depth exceeds capture limit 512")
  let base (tag : String) (xs : List (String × Json) := []) := obj (("tag", str tag) :: ("binderDepth", nat depth) :: xs)
  match e with
  | .bvar i => return base "bvar" [("index", nat i)]
  | .fvar f => return base "fvar" [("symbolId", str (← symbol f.name))]
  | .mvar m => return base "mvar" [("goalId", str (← symbol m.name true))]
  | .sort l => return base "sort" [("level", ← levelJson l)]
  | .const n ls => return base "const" [("name", nameJson n), ("levels", toJson (← ls.mapM levelJson))]
  | .app f a => return base "app" [("function", ← encodeExpr f depth (traversalDepth+1)), ("argument", ← encodeExpr a depth (traversalDepth+1))]
  | .lam n t b bi => return base "lam" [("name", nameJson n), ("binderInfo", str (reprStr bi)), ("type", ← encodeExpr t depth (traversalDepth+1)), ("body", ← encodeExpr b (depth+1) (traversalDepth+1))]
  | .forallE n t b bi => return base "forallE" [("name", nameJson n), ("binderInfo", str (reprStr bi)), ("type", ← encodeExpr t depth (traversalDepth+1)), ("body", ← encodeExpr b (depth+1) (traversalDepth+1))]
  | .letE n t v b nondep => return base "letE" [("name", nameJson n), ("type", ← encodeExpr t depth (traversalDepth+1)), ("value", ← encodeExpr v depth (traversalDepth+1)), ("body", ← encodeExpr b (depth+1) (traversalDepth+1)), ("nondep", toJson nondep)]
  | .lit (.natVal n) => return base "lit" [("kind", str "nat"), ("value", str (toString n))]
  | .lit (.strVal s) => return base "lit" [("kind", str "string"), ("value", str s)]
  | .mdata _ b => return base "mdata" [("metadataStatus", str "omitted"), ("body", ← encodeExpr b depth (traversalDepth+1))]
  | .proj n i b => return base "proj" [("typeName", nameJson n), ("index", nat i), ("body", ← encodeExpr b depth (traversalDepth+1))]

def expression (e : Expr) (ctx : String) : CaptureM String := do
  let body ← encodeExpr e
  let id := "e" ++ toString (← get).expressions.size
  modify fun s => {s with expressions := s.expressions.push (obj [("id", str id), ("contextId", str ctx), ("expression", body)])}
  return id

def context (lctx : LocalContext) : CaptureM String := do
  let id := "c" ++ toString (← get).contexts.size
  let mut entries := #[]
  for d in lctx do
    let sid ← symbol d.fvarId.name
    let typ ← expression d.type id
    let (kind, value, nondep) ← match d with
      | .cdecl .. => pure ("cdecl", Json.null, Json.null)
      | .ldecl _ _ _ _ v nondep _ => do pure ("ldecl", str (← expression v id), toJson nondep)
    entries := entries.push (obj [("symbolId", str sid), ("displayName", nameJson d.userName), ("displayNameText", str d.userName.toString), ("kind", str kind), ("localDeclKind", str (reprStr d.kind)), ("typeExpressionId", str typ), ("valueExpressionId", value), ("binderInfo", str (reprStr d.binderInfo)), ("nondep", nondep)])
  modify fun s => {s with contexts := s.contexts.push (obj [("id", str id), ("locals", arr entries), ("namespaceOptionsStatus", str "unavailable")])}
  return id

def source (stx : Syntax) : Json :=
  let classification := match stx.getHeadInfo with
    | .original .. => "original"
    | .synthetic .. => "synthetic"
    | .none => "missing"
  obj [("classification", str classification), ("startByte", (stx.getPos?).map (fun p => nat p.byteIdx) |>.getD Json.null), ("endByte", (stx.getTailPos?).map (fun p => nat p.byteIdx) |>.getD Json.null)]

def snapshots (gs : List MVarId) (mctx : MetavarContext) (action phase : String) : CaptureM Json := do
  let mut ids := #[]
  for (g, i) in gs.zipIdx do
    let some decl := mctx.findDecl? g | throw (IO.userError "Missing captured goal declaration")
    let gid ← symbol g.name true
    let ctx ← context decl.lctx
    let target ← expression decl.type ctx
    let id := action ++ "/" ++ phase ++ "/" ++ toString i
    modify fun s => {s with snapshots := s.snapshots.push (obj [("id", str id), ("goalId", str gid), ("actionRecordId", str action), ("phase", str phase), ("ordinal", nat i), ("contextId", str ctx), ("targetExpressionId", str target), ("assignmentStatus", str "unknown")])}
    ids := ids.push (str id)
  return arr ids

def infoKind : Info → String
  | .ofTacticInfo _ => "tactic"
  | .ofTermInfo _ => "term"
  | .ofFVarAliasInfo _ => "fvarAlias"
  | .ofPartialTermInfo _ => "partialTerm"
  | .ofCommandInfo _ => "command"
  | .ofMacroExpansionInfo _ => "macroExpansion"
  | .ofOptionInfo _ => "option"
  | .ofErrorNameInfo _ => "errorName"
  | .ofFieldInfo _ => "field"
  | .ofCompletionInfo _ => "completion"
  | .ofUserWidgetInfo _ => "userWidget"
  | .ofCustomInfo _ => "custom"
  | .ofFieldRedeclInfo _ => "fieldRedecl"
  | .ofDelabTermInfo _ => "delabTerm"
  | .ofChoiceInfo _ => "choice"
  | .ofDocInfo _ => "doc"
  | .ofDocElabInfo _ => "docElab"

partial def visit (tree : InfoTree) (ctx : Option ContextInfo) (id : String) (parent : Option String) (selected : List Name) : CaptureM (Option String) := do
  let nextCtx := match tree with | .context c _ => c.mergeIntoOuter? ctx | _ => ctx
  let decl := nextCtx.bind (·.parentDecl?)
  let keep := decl.any (selected.contains ·)
  let (kind, children) := match tree with
    | .context _ t => ("context", #[t])
    | .hole _ => ("hole", #[])
    | .node i cs => (infoKind i, cs.toArray)
  let mut childIds := #[]
  let nextParent := if keep then some id else parent
  let slot := (← get).records.size
  if keep then modify fun s => {s with records := s.records.push Json.null}
  let mut fields := []
  if keep then
    match tree with
    | .node (.ofTacticInfo ti) _ =>
      fields := [("elaborator", nameJson ti.elaborator), ("syntaxKind", str ti.stx.getKind.toString), ("source", source ti.stx), ("beforeGoalSnapshotIds", ← snapshots ti.goalsBefore ti.mctxBefore id "before"), ("afterGoalSnapshotIds", ← snapshots ti.goalsAfter ti.mctxAfter id "after")]
    | .node (.ofTermInfo ti) _ =>
      let cid ← context ti.lctx
      let eid ← expression ti.expr cid
      let expected ← ti.expectedType?.mapM (fun e => expression e cid)
      fields := [("contextId", str cid), ("elaborator", nameJson ti.elaborator), ("syntaxKind", str ti.stx.getKind.toString), ("source", source ti.stx), ("expressionId", str eid), ("expectedTypeId", toJson expected), ("isBinder", toJson ti.isBinder), ("isDisplayableTerm", toJson ti.isDisplayableTerm)]
    | .node (.ofFVarAliasInfo ai) _ =>
      fields := [("symbolId", str (← symbol ai.id.name)), ("baseSymbolId", str (← symbol ai.baseId.name)), ("displayName", nameJson ai.userName)]
    | _ => fields := [("payloadStatus", str "unsupported")]
  for i in [:children.size] do
    if let some child ← visit children[i]! nextCtx (id ++ "/" ++ toString i) nextParent selected then
      childIds := childIds.push (str child)
  if keep then
    let record := obj (fields ++ [("id", str id), ("parentId", toJson parent), ("childIds", arr childIds), ("kind", str kind), ("declarationId", toJson (decl.map Name.toString))] ++ (if kind == "term" then [] else [("contextId", Json.null)]))
    modify fun s => {s with records := s.records.set! slot record}
    return some id
  else
    modify fun s => {s with roots := s.roots ++ childIds}
    return none

unsafe def main (args : List String) : IO Unit := do
  let path := args.headD ""
  let selected := args.drop 1 |>.map String.toName
  if path.isEmpty || selected.isEmpty then throw (IO.userError "Source and declaration names required")
  initSearchPath (← findSysroot)
  enableInitializersExecution
  let input ← IO.FS.readFile path
  let ictx := Parser.mkInputContext input path
  let (header, ps, msgs) ← Parser.parseHeader ictx
  let (env, msgs) ← processHeader header {} msgs ictx
  let opts := Elab.async.set {} false
  let final ← Elab.IO.processCommands ictx ps (Command.mkState env msgs opts)
  let mut diagnostics := #[]
  for msg in final.commandState.messages.toList do
    diagnostics := diagnostics.push (obj [("severity", str (toString msg.severity)), ("message", str (← msg.toString))])
  if final.commandState.messages.hasErrors then
    throw (IO.userError (Json.compress (arr diagnostics)))
  let (decls, captured) ← (do
    for (tree, i) in final.commandState.infoState.trees.toArray.zipIdx do
      if let some root ← visit tree none ("r" ++ toString i) none selected then
        modify fun s => {s with roots := s.roots.push (str root)}
    let mut decls := #[]
    for n in selected do
      let some ci := final.commandState.env.find? n | throw (IO.userError s!"Unknown declaration {n}")
      let cid ← context {}
      let typ ← expression ci.type cid
      let value ← (ci.value? true).mapM (fun e => expression e cid)
      let containsSorry := (ci.value? true).any (fun e => (e.find? (fun e => e.isConstOf ``sorryAx)).isSome)
      decls := decls.push (obj [("id", str n.toString), ("name", nameJson n), ("typeExpressionId", str typ), ("valueExpressionId", toJson value), ("proofStatus", obj [("kind", str (if ci.isAxiom then "axiom" else if ci.isTheorem then "theorem" else "definition")), ("containsSorry", toJson containsSorry), ("transitiveTrust", str "unscanned")])])
    return decls : CaptureM (Array Json)).run {}
  IO.println (Json.compress (obj [("importedModules", toJson (final.commandState.env.header.moduleNames.toList.map Name.toString)), ("declarations", arr decls), ("records", arr captured.records), ("contexts", arr captured.contexts), ("expressions", arr captured.expressions), ("goalSnapshots", arr captured.snapshots), ("infoRoots", arr captured.roots), ("goals", arr (captured.goals.mapIdx fun i _ => obj [("id", str ("g" ++ toString i)), ("contextCoverage", str "snapshots-only")])), ("symbols", arr (captured.symbols.mapIdx fun i _ => obj [("id", str ("v" ++ toString i))])), ("universeMetavariables", arr (captured.universes.mapIdx fun i _ => obj [("id", str ("u" ++ toString i))])), ("diagnostics", arr diagnostics)]))
end ProofAtlas

unsafe def main := ProofAtlas.main
