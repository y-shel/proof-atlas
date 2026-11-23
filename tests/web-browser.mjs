import puppeteer from "puppeteer-core";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile, readFile } from "node:fs/promises";
const auditNames = ["constructive", "admitted", "viaAdmission", "viaAxioms", "typeDependency", "tallyAppend"];
execFileSync("python3", ["scripts/export_evidence.py", "experiments/native-extraction/AxiomAudit.lean",
  ...auditNames.flatMap(n => ["--declaration", "AuditFixture." + n]),
  "--output", "/tmp/proof-atlas-axiom-evidence.json"]);
execFileSync("python3", ["scripts/project_graph.py", "/tmp/proof-atlas-axiom-evidence.json",
  "--source", "experiments/native-extraction/AxiomAudit.lean", "--output", "/tmp/proof-atlas-axiom-graph.json"]);
const browser = await puppeteer.launch({
  executablePath: "/sbin/chromium",
  headless: true,
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 1000 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:5173");
  await page.click("#demo");
  await page.waitForSelector(".chunk");
  async function assertFit() {
    await page.waitForFunction(
      () => document.querySelector("#graph").dataset.layout,
    );
    const result = await page.$eval("#graph", (n) => ({
      nodes: JSON.parse(n.dataset.layout),
      width: n.clientWidth,
      height: n.clientHeight,
      label: n.dataset.labelPixels,
    }));
    assert.equal(result.label, "14");
    for (const n of result.nodes) {
      assert.ok(n.sx >= 20 && n.sx <= result.width - 20);
      assert.ok(n.sy >= 85 && n.sy <= result.height - 80);
    }
  }
  await assertFit();
  const initialKey = await page.$eval("#graph", (n) => n.dataset.viewKey);

  assert.match(
    await page.$eval("#status", (n) => n.textContent),
    /SHA-256 matches/,
  );
  await page.select("#declaration", "repeated");
  await new Promise((r) => setTimeout(r, 100));
  await assertFit();
  assert.notEqual(
    await page.$eval("#graph", (n) => n.dataset.viewKey),
    initialKey,
  );
  assert.ok(await page.$$eval(".chunk", (ns) => ns.length));
  const repeatedIndex = await page.$$eval(".chunk", (ns) =>
    ns.findIndex(
      (n) =>
        /exact hp/.test(n.textContent) &&
        /2 recorded occurrence/.test(n.textContent),
    ),
  );
  assert.ok(repeatedIndex >= 0);
  await (await page.$$(".chunk"))[repeatedIndex].click();
  assert.equal(await page.$$eval(".execution", (ns) => ns.length), 2);
  assert.equal(
    await page.$eval("#source mark", (n) => n.textContent),
    "exact hp",
  );
  await page.waitForFunction(
    () => document.querySelector("#graph").dataset.camera,
  );
  const camera = await page.$eval("#graph", (n) => n.dataset.camera);
  const positions = await page.$eval("#graph", (n) =>
    JSON.parse(n.dataset.layout),
  );
  await page.click("#hidden");
  await page.click(".chunk");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await page.$eval("#graph", (n) => n.dataset.camera), camera);
  const after = await page.$eval("#graph", (n) => JSON.parse(n.dataset.layout));
  for (const n of positions) {
    const a = after.find((a) => a.id === n.id);
    assert.equal(a.x, n.x);
    assert.equal(a.y, n.y);
  }
  assert.ok(await page.$$eval(".execution", (ns) => ns.length));
  assert.ok((await page.$eval("#selection", (n) => n.textContent)).length < 73);
  assert.equal(
    await page.$eval(".execution h3", (n) => n.textContent),
    "Execution 1",
  );
  await page.focus(".chunk");
  await page.keyboard.press("Enter");
  const box = await page.$eval("#graph", (n) => {
    const b = n.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  await page.mouse.wheel({ deltaY: -250 });
  await new Promise((r) => setTimeout(r, 300));
  assert.notEqual(await page.$eval("#graph", (n) => n.dataset.camera), camera);
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + 70, box.y + 40, { steps: 6 });
  await page.mouse.up();
  const pan = await page.$eval("#graph", (n) => n.dataset.camera);
  await page.click("#hidden");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await page.$eval("#graph", (n) => n.dataset.camera), pan);
  await page.select("#declaration", "branches");
  await new Promise((r) => setTimeout(r, 100));
  await assertFit();
  await page.select("#declaration", "repeated");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await page.$eval("#graph", (n) => n.dataset.camera), pan);
  const input = await page.$("#file");
  await input.uploadFile("web/public/demo.json");
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.startsWith("demo.json"),
  );
  const malformed = JSON.parse(await readFile("web/public/demo.json", "utf8"));
  const chunk = malformed.chunks[0];
  chunk.text = null;
  chunk.source = {
    classification: "synthetic",
    startByte: null,
    endByte: null,
  };
  chunk.syntaxKind = 42;
  for (const id of chunk.occurrenceIds) {
    malformed.evidence.records[id].source = chunk.source;
    malformed.evidence.records[id].syntaxKind = 42;
  }
  await writeFile("/tmp/proof-atlas-malformed.json", JSON.stringify(malformed));
  const prior = await page.$eval("#graph", (n) => ({
    key: n.dataset.viewKey,
    camera: n.dataset.camera,
    layout: n.dataset.layout,
  }));
  await input.uploadFile("/tmp/proof-atlas-malformed.json");
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("Cannot open graph"),
  );
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(
    await page.$eval("#graph", (n) => ({
      key: n.dataset.viewKey,
      camera: n.dataset.camera,
      layout: n.dataset.layout,
    })),
    prior,
  );
  assert.deepEqual(errors, []);
  await page.select("#declaration", "termOnly");
  await page.click(".chunk");
  assert.equal(await page.$$eval(".execution h4", (ns) => ns.length), 0);
  assert.match(
    await page.$eval(".execution h3", (n) => n.textContent),
    /Occurrence/,
  );
  const termDetail = await page.$$(".execution details");
  assert.ok(termDetail.length);
  assert.match(
    await page.$eval("#inspector", (n) => n.textContent),
    /Expression and context/,
  );
  await input.uploadFile("/tmp/proof-atlas-axiom-graph.json");
  await page.waitForFunction(() => document.querySelector("#status").textContent.startsWith("proof-atlas-axiom-graph.json"));
  const basisText = () => page.$eval("#basis", n => n.textContent);
  assert.match(await basisText(), /Axiom audit · collected/);
  assert.match(await basisText(), /No axioms reported/);
  await page.select("#declaration", "AuditFixture.admitted");
  assert.match(await basisText(), /Direct sorryAx occurrence in declaration value · yes/);
  assert.match(await basisText(), /Admission reachable.* · yes/);
  assert.match(await basisText(), /"value":"sorryAx"/);
  await page.select("#declaration", "AuditFixture.viaAdmission");
  assert.match(await basisText(), /Direct sorryAx occurrence in declaration value · no/);
  assert.match(await basisText(), /Admission reachable.* · yes/);
  await page.select("#declaration", "AuditFixture.viaAxioms");
  assert.match(await basisText(), /injectedFalse/);
  assert.match(await basisText(), /anotherFalse/);
  assert.match(await basisText(), /Admission reachable.* · no/);
  assert.equal(await page.$$eval("#basis input, #basis button, #basis select", ns => ns.length), 0);
  await page.select("#declaration", "AuditFixture.typeDependency");
  assert.match(await basisText(), /assumedType/);
  await page.select("#declaration", "AuditFixture.tallyAppend");
  assert.match(await basisText(), /propext/);
  assert.ok(await page.$$eval(".chunk", ns => ns.some(n => /induction/.test(n.textContent))));
  await page.click("#hidden");
  assert.ok(await page.$$eval(".chunk", ns => ns.length));
  await page.screenshot({ path: "/tmp/proof-atlas-axiom-medium.png", fullPage: true });
  const audited = JSON.parse(await readFile("/tmp/proof-atlas-axiom-graph.json", "utf8"));
  for (const [label, audit] of [
    ["legacy", undefined],
    ["unknown", {status: "unknown", reason: "not recorded"}],
    ["error", {status: "error", reason: "native collection failed"}],
    ["malformed", {status: "collected", axioms: [], containsAdmission: true}],
  ]) {
    const imported = structuredClone(audited);
    const proof = imported.evidence.declarations[0].proofStatus;
    if (audit === undefined) { delete proof.axiomAudit; proof.transitiveTrust = "unscanned"; }
    else proof.axiomAudit = audit;
    const path = "/tmp/proof-atlas-audit-" + label + ".json";
    await writeFile(path, JSON.stringify(imported));
    await input.uploadFile(path);
    await page.waitForFunction(name => document.querySelector("#status").textContent.startsWith(name), {}, path.split("/").at(-1));
    assert.match(await basisText(), new RegExp("Axiom audit · " + (["legacy", "unknown"].includes(label) ? "unknown" : "error")));
    assert.match(await basisText(), /Admission reachable.* · unknown/);
    assert.doesNotMatch(await basisText(), /No axioms reported/);
    assert.ok(await page.$$eval(".chunk", ns => ns.length));
  }
  await writeFile("/tmp/proof-atlas-invalid.json", "{}");
  await input.uploadFile("/tmp/proof-atlas-invalid.json");
  await page.waitForFunction(() =>
    document
      .querySelector("#status")
      .textContent.includes("Unsupported graph schema"),
  );
  await page.click("#demo");
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.startsWith("Prepared"),
  );
  await page.click("#reset");
  await new Promise((r) => setTimeout(r, 100));
  await assertFit();
  await page.screenshot({ path: "/tmp/proof-atlas-web.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    "Browser interactions passed; screenshot /tmp/proof-atlas-web.png",
  );
} finally {
  await browser.close();
}
