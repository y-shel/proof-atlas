import { select } from "d3-selection";
import { zoom, zoomIdentity } from "d3-zoom";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
} from "d3-force";
export function createCanvas(canvas, onSelect) {
  const ctx = canvas.getContext("2d");
  let nodes = [],
    links = [],
    selected = null,
    camera = zoomIdentity,
    dirty = false,
    width = 1,
    height = 1;
  const views = new Map();
  let activeKey = null,
    state = null;
  const navigation = zoom()
    .scaleExtent([0.15, 5])
    .on("zoom", (e) => {
      camera = e.transform;
      if (state) state.camera = camera;
      redraw();
    });
  select(canvas).call(navigation).on("dblclick.zoom", null);
  function redraw() {
    if (dirty) return;
    dirty = true;
    requestAnimationFrame(draw);
  }
  function draw() {
    dirty = false;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(camera.x + width / 2, camera.y + height / 2);
    ctx.scale(camera.k, camera.k);
    for (const n of nodes) {
      const glow = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, 90);
      glow.addColorStop(0, n.chunk.kind === "term" ? "#9c8fe020" : "#4dc9ba20");
      glow.addColorStop(1, "transparent");
      ctx.fillStyle = glow;
      ctx.fillRect(n.x - 90, n.y - 90, 180, 180);
    }
    ctx.strokeStyle = "#53718a";
    ctx.lineWidth = 1 / camera.k;
    for (const l of links) {
      ctx.beginPath();
      ctx.moveTo(l.source.x, l.source.y);
      ctx.lineTo(l.target.x, l.target.y);
      ctx.stroke();
    }
    for (const n of nodes) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, (n.id === selected ? 9 : 6) / camera.k, 0, Math.PI * 2);
      ctx.fillStyle =
        n.id === selected
          ? "#eee6ff"
          : n.chunk.kind === "term"
            ? "#baacf0"
            : "#69dac6";
      ctx.fill();
    }
    ctx.restore();
    ctx.font = "14px system-ui";
    const occupied = [];
    const screenNodes = nodes.map((n) => ({
      ...n,
      sx: width / 2 + camera.x + n.x * camera.k,
      sy: height / 2 + camera.y + n.y * camera.k,
    }));
    for (const n of screenNodes.sort(
      (a, b) => Number(b.id === selected) - Number(a.id === selected),
    )) {
      const text = n.label.replace(/\s+/g, " ").slice(0, 32);
      const w = ctx.measureText(text).width;
      const x = Math.max(12, Math.min(width - w - 12, n.sx + 14)),
        y = n.sy + 5;
      const box = { x, y: y - 15, w, h: 19 };
      if (
        n.id !== selected &&
        (y < 90 ||
          y > height - 85 ||
          occupied.some(
            (b) =>
              box.x < b.x + b.w + 8 &&
              box.x + box.w + 8 > b.x &&
              box.y < b.y + b.h + 5 &&
              box.y + box.h + 5 > b.y,
          ))
      )
        continue;
      occupied.push(box);
      ctx.fillStyle = "#0b1322";
      ctx.fillRect(x - 3, y - 15, w + 6, 20);
      ctx.fillStyle = "#e4edf7";
      ctx.fillText(text, x, y);
    }
    canvas.dataset.layout = JSON.stringify(
      screenNodes.map((n) => ({
        id: n.id,
        x: n.x,
        y: n.y,
        sx: n.sx,
        sy: n.sy,
      })),
    );
    canvas.dataset.viewKey = activeKey;
    canvas.dataset.labelPixels = "14";
    canvas.dataset.camera = JSON.stringify([camera.x, camera.y, camera.k]);
  }
  function fit() {
    if (!nodes.length || width <= 1 || height <= 1) return;
    const minX = Math.min(...nodes.map((n) => n.x)),
      maxX = Math.max(...nodes.map((n) => n.x));
    const minY = Math.min(...nodes.map((n) => n.y)),
      maxY = Math.max(...nodes.map((n) => n.y));
    const k = Math.max(
      0.15,
      Math.min(
        1.5,
        (width - 260) / Math.max(1, maxX - minX),
        (height - 210) / Math.max(1, maxY - minY),
      ),
    );
    const x = (-(minX + maxX) / 2) * k - 70,
      y = (-(minY + maxY) / 2) * k + 5;
    select(canvas).call(
      navigation.transform,
      zoomIdentity.translate(x, y).scale(k),
    );
  }
  function setView(view, key) {
    const changed = key !== activeKey;
    activeKey = key;
    if (!views.has(key)) views.set(key, { positions: new Map(), camera: null });
    state = views.get(key);
    const positions = state.positions;
    nodes = view.nodes.map((n, i) => ({
      ...n,
      ...(positions.get(n.id) || {
        x: Math.cos(i * 2.4) * 200,
        y: Math.sin(i * 2.4) * 180,
      }),
    }));
    links = view.links.map((l) => ({ ...l }));
    if (nodes.some((n) => !positions.has(n.id))) {
      const old = nodes.filter((n) => positions.has(n.id));
      old.forEach((n) => {
        n.fx = n.x;
        n.fy = n.y;
      });
      const sim = forceSimulation(nodes)
        .force(
          "link",
          forceLink(links)
            .id((n) => n.id)
            .distance(110),
        )
        .force("charge", forceManyBody().strength(-160))
        .force("center", forceCenter(0, 0))
        .force("collision", forceCollide(44))
        .stop();
      for (let i = 0; i < 160; i++) sim.tick();
      nodes.forEach((n) => {
        positions.set(n.id, { x: n.x, y: n.y });
        delete n.fx;
        delete n.fy;
      });
    } else {
      const lookup = new Map(nodes.map((n) => [n.id, n]));
      links.forEach((l) => {
        l.source = lookup.get(l.source);
        l.target = lookup.get(l.target);
      });
    }
    if (changed) {
      if (state.camera) select(canvas).call(navigation.transform, state.camera);
      else fit();
    }
    redraw();
  }
  canvas.addEventListener("click", (e) => {
    if (e.defaultPrevented) return;
    const r = canvas.getBoundingClientRect(),
      x = (e.clientX - r.left - width / 2 - camera.x) / camera.k,
      y = (e.clientY - r.top - height / 2 - camera.y) / camera.k;
    const n = nodes.find((n) => Math.hypot(x - n.x, y - n.y) < 18 / camera.k);
    if (n) onSelect(n.id);
  });
  const resize = new ResizeObserver(() => {
    const r = canvas.getBoundingClientRect();
    width = r.width;
    height = r.height;
    canvas.width = width * devicePixelRatio;
    canvas.height = height * devicePixelRatio;
    if (state && !state.camera) fit();
    redraw();
  });
  resize.observe(canvas);
  return {
    setView,
    select(id) {
      selected = id;
      redraw();
    },
    fit,
    destroy() {
      resize.disconnect();
      select(canvas).on(".zoom", null);
    },
  };
}
