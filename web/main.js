import "./style.css";
import {
  loadGraph,
  declarationBasis,
  sourceParts,
  overview,
  witnessValue,
} from "./graph-model.js";
import { createCanvas } from "./graph-canvas.js";
const $ = (id) => document.getElementById(id);
let model = null,
  view = null,
  current = null;
const graph = createCanvas($("graph"), selectChunk);
function el(tag, text) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  return n;
}
function details(parent, title, data) {
  const d = el("details"),
    s = el("summary", title);
  d.append(s, el("pre", JSON.stringify(data, null, 2)));
  parent.append(d);
}
async function open(data, name) {
  try {
    const next = await loadGraph(data);
    model = next;
    $("declaration").replaceChildren(
      ...model.declarations.map((d) => {
        const o = el("option", d.id);
        o.value = d.id;
        return o;
      }),
    );
    $("declaration").disabled = false;
    $("status").textContent =
      name +
      " · source SHA-256 matches · imported graph semantics not rechecked in Lean";
    $("hidden").checked = false;
    update();
  } catch (e) {
    $("status").textContent = "Cannot open graph: " + e.message;
  }
}
function update() {
  if (!model) return;
  renderBasis();
  view = overview(model, $("declaration").value, $("hidden").checked);
  graph.setView(view, model.graph.artifactId + ":" + $("declaration").value);
  $("count").textContent = view.nodes.length + " chunks · source grouping only";
  $("chunks").replaceChildren(
    ...view.nodes.map((n) => {
      const b = el("button");
      b.className = "chunk";
      b.dataset.id = n.id;
      b.append(
        el("span", n.label || n.chunk.kind),
        el(
          "small",
          n.chunk.kind +
            " · " +
            n.chunk.occurrenceIds.length +
            " recorded occurrence(s) · " +
            n.chunk.visibilityReason,
        ),
      );
      b.onclick = () => selectChunk(n.id);
      return b;
    }),
  );
  if (!view.nodes.some((n) => n.id === current)) current = view.nodes[0]?.id;
  selectChunk(current);
}
function renderBasis() {
  const declaration = model.declarations.find(d => d.id === $("declaration").value);
  const basis = declarationBasis(declaration);
  const panel = $("basis");
  panel.replaceChildren(el("h2", "Declaration basis"));
  panel.append(el("p", "Axiom audit · " + basis.status));
  panel.append(el("p", "Reported provenance under the recorded formal environment. Local goal hypotheses are shown with each goal."));
  const state = value => value === null ? "unknown" : value ? "yes" : "no";
  panel.append(el("p", "Direct sorryAx occurrence in declaration value · " + state(basis.directAdmission)));
  panel.append(el("p", "Admission reachable through declaration types, values and dependencies · " + state(basis.containsAdmission)));
  if (basis.status === "collected") {
    panel.append(el("p", basis.axioms.length ? "Reported axiom Names" : "No axioms reported by this collection."));
    for (const name of basis.axioms) panel.append(el("pre", JSON.stringify(name)));
  } else panel.append(el("p", basis.reason));
  details(panel, "Recorded declaration provenance", declaration?.proofStatus ?? {});
}
function selectChunk(id) {
  if (!model) return;
  current = id;
  graph.select(id);
  for (const b of $("chunks").children)
    b.setAttribute("aria-pressed", String(b.dataset.id === id));
  const c = view.nodes.find((n) => n.id === id)?.chunk;
  $("inspector").replaceChildren();
  $("source").replaceChildren();
  if (!c) {
    $("selection").textContent = "No source chunks";
    $("scope").textContent = "Try showing hidden records.";
    return;
  }
  $("selection").textContent =
    c.text?.trim().split("\n")[0].slice(0, 72) || c.kind;
  $("scope").textContent =
    c.kind + " · " + c.occurrenceIds.length + " recorded occurrence(s)";
  const parts = sourceParts(model, c);
  if (parts) {
    $("source").append(
      document.createTextNode(parts[0]),
      el("mark", parts[1]),
      document.createTextNode(parts[2]),
    );
  } else {
    $("source").textContent = model.graph.source.text;
    $("scope").append(" · No verified original source range for this record.");
  }
  details($("inspector"), "Chunk record", c);
  const evidence = model.graph.evidence;
  for (const [index, oid] of c.occurrenceIds.entries()) {
    const r = evidence.records[oid];
    const section = el("section");
    section.className = "execution";
    const isTactic = r.kind === "tactic";
    section.append(
      el(
        "h3",
        (isTactic
          ? "Execution "
          : r.isBinder
            ? "Binder occurrence "
            : "Occurrence ") +
          (index + 1),
      ),
    );
    if (!isTactic) {
      if (r.kind === "term") {
        details(section, "Expression and context", {
          expression:
            evidence.expressions[r.expressionId] ??
            "Unavailable: expression not captured",
          expectedType:
            evidence.expressions[r.expectedTypeId] ??
            "Unavailable: expected type not captured",
          context:
            evidence.contexts[r.contextId] ??
            "Unavailable: context not captured",
        });
      } else
        section.append(
          el(
            "p",
            "Expression and context unavailable for this " +
              r.kind +
              " record.",
          ),
        );
    }

    for (const phase of isTactic ? ["before", "after"] : []) {
      section.append(
        el("h4", phase === "before" ? "Input goals" : "Output goals"),
      );
      const snapshots = r[phase + "GoalSnapshotIds"] || [];
      if (!snapshots.length)
        section.append(
          el("p", "No recorded snapshots. This does not establish solving."),
        );
      for (const sid of snapshots) {
        const s = evidence.goalSnapshots[sid];
        details(
          section,
          "Goal " +
            (s.ordinal + 1) +
            " · " +
            (phase === "before" ? "input state" : "output state"),
          {
            snapshot: s,
            target: evidence.expressions[s.targetExpressionId],
            orderedLocals: evidence.contexts[s.contextId]?.locals,
          },
        );
      }
    }
    const related = model.graph.edges.filter(
      (e) =>
        e.source === "occurrence:" + oid || e.target === "occurrence:" + oid,
    );
    for (const edge of related) {
      let resolved;
      try {
        resolved = witnessValue(model, edge);
      } catch (e) {
        resolved = e.message;
      }
      details(section, edge.kind + " · " + edge.id, {
        edge,
        resolvedWitness: resolved,
        sourceNode: model.graph.nodes[edge.source],
        targetNode: model.graph.nodes[edge.target],
      });
    }
    details(section, isTactic ? "Raw execution" : "Raw occurrence", r);
    $("inspector").append(section);
  }
  details(
    $("inspector"),
    "Overview containment paths",
    view.links.filter((l) => l.source === id || l.target === id),
  );
  details($("inspector"), "Coverage and limits", model.graph.limitations);
  details($("inspector"), "Full immutable graph artifact", model.graph);
}
$("demo").onclick = async () => {
  try {
    const r = await fetch("/demo.json");
    if (!r.ok) throw Error("Run npm run demo to prepare the sample");
    await open(await r.json(), "Prepared native Lean sample");
  } catch (e) {
    $("status").textContent = e.message;
  }
};
$("file").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    await open(JSON.parse(await f.text()), f.name);
  } catch (err) {
    $("status").textContent = "Cannot open graph: " + err.message;
  }
};
$("declaration").onchange = () => {
  current = null;
  update();
};
$("hidden").onchange = update;
$("reset").onclick = () => graph.fit();
