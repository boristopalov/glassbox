import { createScene } from "./scene.js";

const $ = (s) => document.querySelector(s);
const DPR = () => Math.min(window.devicePixelRatio || 1, 2);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const now = () => performance.now();

const C = {
  ink: "#dbe7ff", ink2: "#8ea2c8", ink3: "#4f6187",
  cyan: "#00f0ff", magenta: "#ff2bd6", violet: "#9b6bff", amber: "#ffb020", red: "#ff3d5a", green: "#2bff9a",
};
const FAMILY = { scan: C.cyan, pipe: C.violet, join: C.magenta, blocking: C.amber, dml: C.green, ddl: "#8ea2c8" };
const PALETTE = ["#00f0ff", "#ff2bd6", "#2bff9a", "#ffd23d", "#9b6bff", "#3d8bff", "#ff5f6d", "#7dffef", "#c6ff3d", "#ff9ce6"];
const SYSTEM_COLOR = "#62739a";
const SPILL_COLOR = "#ff8a3d";
const BATCH_STEPS = [1, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048];
const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4, 10];
const SNAP_EVERY = 1500;
const LANES = ["T1", "T2", "B1", "B2"];
const MONO = '"JetBrains Mono", ui-monospace, monospace';

const S = {
  frames: 0,
  owners: [],
  ownerColor: new Map(),
  trace: null,
  model: null,
  snaps: [],
  cursor: 0,
  applied: 0,
  playing: false,
  speed: 1,
  rate: 300,
  stmtShown: -1,
  plans: [],
  planShown: null,
  selection: null,
  ledR: 0,
  ledW: 0,
  rowsShown: -1,
  lastTick: now(),
  busy: false,
  timelineImg: null,
  dirtyUI: true,
};

/* ---------- model: the buffer pool and plan state at a point in the trace ---------- */

function mapOf(obj) {
  const m = new Map();
  for (const [k, v] of Object.entries(obj || {})) m.set(+k, v);
  return m;
}

function modelFrom(snap) {
  return {
    frames: snap.frames.slice(),
    lanes: snap.lanes.map((l) => l.slice()),
    target: snap.target,
    owner: mapOf(snap.page_owner),
    kind: mapOf(snap.page_kind),
    keys: mapOf(snap.page_keys),
    dirty: new Set(),
    counters: Object.assign({}, snap.counters),
    nodes: {},
    rows: {},
    stmt: 0,
    lastNode: null,
  };
}

function cloneModel(m) {
  const nodes = {};
  for (const k in m.nodes) nodes[k] = Object.assign({}, m.nodes[k], { path: m.nodes[k].path.slice() });
  return {
    frames: m.frames.slice(),
    lanes: m.lanes.map((l) => l.slice()),
    target: m.target,
    owner: new Map(m.owner),
    kind: new Map(m.kind),
    keys: new Map(m.keys),
    dirty: new Set(m.dirty),
    counters: Object.assign({}, m.counters),
    nodes,
    rows: Object.assign({}, m.rows),
    stmt: m.stmt,
    lastNode: m.lastNode,
  };
}

function laneMove(m, p, to) {
  for (const l of m.lanes) {
    const i = l.indexOf(p);
    if (i >= 0) l.splice(i, 1);
  }
  if (to != null) m.lanes[LANES.indexOf(to)].unshift(p);
}

function place(m, p, f) {
  for (let i = 0; i < m.frames.length; i++) if (i !== f && m.frames[i] === p) m.frames[i] = null;
  m.frames[f] = p;
}

function node(m, n) {
  const key = m.stmt + ":" + n;
  return m.nodes[key] || (m.nodes[key] = { rows: 0, batches: 0, state: "idle", hits: 0, misses: 0, news: 0, path: [] });
}

const TREE_KINDS = new Set(["header", "internal", "leaf"]);

function tracePath(m, nd, p) {
  const kind = m.kind.get(p);
  if (!TREE_KINDS.has(kind)) return;
  const last = nd.path[nd.path.length - 1];
  if (last && last[0] === p) { last[1] = kind; return; }
  if (kind === "header") nd.path = [];
  nd.path.push([p, kind]);
  if (nd.path.length > 6) nd.path.shift();
}

function apply(m, e) {
  switch (e.k) {
    case "stmt": m.stmt = e.i; m.lastNode = null; break;
    case "open": node(m, e.n).state = "open"; m.lastNode = e.n; break;
    case "batch": {
      const nd = node(m, e.n);
      nd.rows += e.rows; nd.batches++; nd.state = "run"; m.lastNode = e.n;
      if (e.n === 0) m.rows[m.stmt] = (m.rows[m.stmt] || 0) + e.rows;
      break;
    }
    case "done": node(m, e.n).state = "done"; m.lastNode = e.n; break;
    case "close": { const nd = node(m, e.n); if (nd.state !== "done") nd.state = "done"; break; }
    case "hit": {
      const k = 1 + (e.x || 0);
      m.counters.hits += k;
      place(m, e.p, e.f);
      laneMove(m, e.p, "T2");
      if (e.w) m.dirty.add(e.p);
      if (e.n != null) { const nd = node(m, e.n); nd.hits += k; m.lastNode = e.n; tracePath(m, nd, e.p); }
      break;
    }
    case "miss":
      m.counters.misses++;
      if (e.n != null) { node(m, e.n).misses++; m.lastNode = e.n; }
      break;
    case "load":
      if (e.n != null) tracePath(m, node(m, e.n), e.p);
      place(m, e.p, e.f);
      laneMove(m, e.p, e.how === "ghost" ? "T2" : "T1");
      if (e.how === "new") { m.counters.allocs++; m.dirty.add(e.p); if (e.n != null) node(m, e.n).news++; }
      break;
    case "lane": laneMove(m, e.p, e.to); break;
    case "evict":
      if (m.frames[e.f] === e.p) m.frames[e.f] = null;
      laneMove(m, e.p, e.to);
      m.counters.evictions++;
      m.dirty.delete(e.p);
      break;
    case "unevict": place(m, e.p, e.f); laneMove(m, e.p, e.to); m.counters.evictions--; break;
    case "free":
      for (let i = 0; i < m.frames.length; i++) if (m.frames[i] === e.p) m.frames[i] = null;
      laneMove(m, e.p, null);
      m.owner.delete(e.p); m.kind.delete(e.p); m.keys.delete(e.p); m.dirty.delete(e.p);
      break;
    case "target": m.target = e.v; break;
    case "io":
      if (e.w) { m.counters.writes++; m.dirty.delete(e.p); } else m.counters.reads++;
      break;
    case "kind":
      m.kind.set(e.p, e.kind);
      if (e.keys != null) m.keys.set(e.p, e.keys);
      if (m.lastNode != null) tracePath(m, node(m, m.lastNode), e.p);
      break;
    case "owner": m.owner.set(e.p, e.o); break;
  }
}

/* ---------- trace loading and seeking ---------- */

function setOwners(owners) {
  S.owners = owners;
  let next = 0;
  for (const o of owners) {
    if (S.ownerColor.has(o.id)) { if (o.kind !== "system" && o.kind !== "spill") next++; continue; }
    let color;
    if (o.kind === "system") color = SYSTEM_COLOR;
    else if (o.kind === "spill") color = SPILL_COLOR;
    else color = PALETTE[next++ % PALETTE.length];
    S.ownerColor.set(o.id, color);
  }
}

function ownerColor(oid) {
  return oid == null ? SYSTEM_COLOR : S.ownerColor.get(oid) || SYSTEM_COLOR;
}

function loadTrace(trace) {
  S.trace = trace;
  setOwners(trace.owners);
  S.model = modelFrom(trace.before);
  S.snaps = [cloneModel(S.model)];
  const probe = cloneModel(S.model);
  const ev = trace.events;
  for (let i = 0; i < ev.length; i++) {
    apply(probe, ev[i]);
    if ((i + 1) % SNAP_EVERY === 0) S.snaps.push(cloneModel(probe));
  }
  S.plans = trace.statements.map((s) => (s.plan ? layoutPlan(s.plan) : null));
  S.cursor = 0;
  S.applied = 0;
  scene.clearEffects();
  S.planShown = null;
  S.rowsShown = -1;
  const n = ev.length;
  const duration = clamp(n / 140, 2.4, 9);
  S.rate = Math.max(1, n / duration);
  S.stmtShown = -1;
  buildTimeline();
  renderStatements();
  S.playing = n > 0;
  updatePlayButton();
  S.dirtyUI = true;
}

function seek(target) {
  if (!S.trace) return;
  const n = S.trace.events.length;
  target = clamp(target, 0, n);
  const whole = Math.floor(target);
  if (whole < S.applied || whole - S.applied > SNAP_EVERY) {
    const si = Math.min(Math.floor(whole / SNAP_EVERY), S.snaps.length - 1);
    S.model = cloneModel(S.snaps[si]);
    S.applied = si * SNAP_EVERY;
    scene.clearEffects();
  }
  const ev = S.trace.events;
  while (S.applied < whole) apply(S.model, ev[S.applied++]);
  S.cursor = target;
  S.dirtyUI = true;
}

function advance(dt) {
  if (!S.trace || !S.playing) return;
  const n = S.trace.events.length;
  const before = S.applied;
  S.cursor = Math.min(n, S.cursor + S.rate * S.speed * dt);
  const whole = Math.floor(S.cursor);
  const count = whole - before;
  const budget = 70;
  const stride = Math.max(1, Math.floor(count / budget));
  const ev = S.trace.events;
  let i = 0;
  while (S.applied < whole) {
    const e = ev[S.applied++];
    apply(S.model, e);
    if (i++ % stride === 0 || e.k === "batch" || e.k === "evict" || e.k === "stmt") effect(e);
  }
  if (S.cursor >= n) { S.playing = false; updatePlayButton(); }
  if (count > 0) S.dirtyUI = true;
}

/* ---------- visual effects ---------- */

function effect(e) {
  if (e.k === "io") { if (e.w) S.ledW = now(); else S.ledR = now(); }
  scene.effect(e, S.model);
}

/* ---------- plan layout ---------- */

function layoutPlan(root) {
  const nodes = [];
  const byId = new Map();
  const parent = new Map();
  let leaf = 0;
  let depthMax = 0;
  (function walk(n, depth) {
    n.depth = depth;
    depthMax = Math.max(depthMax, depth);
    byId.set(n.id, n);
    if (!n.children.length) n.lx = leaf++;
    else {
      for (const c of n.children) { parent.set(c.id, n.id); walk(c, depth + 1); }
      n.lx = n.children.reduce((a, c) => a + c.lx, 0) / n.children.length;
    }
    nodes.push(n);
  })(root, 0);
  return { root, nodes, byId, parent };
}


function fitCanvas(cv) {
  const r = cv.getBoundingClientRect();
  const d = DPR();
  const w = Math.max(1, Math.round(r.width * d));
  const h = Math.max(1, Math.round(r.height * d));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return { w: r.width, h: r.height, d };
}

function roundRect(cx, x, y, w, h, r) {
  cx.beginPath();
  cx.moveTo(x + r, y);
  cx.arcTo(x + w, y, x + w, y + h, r);
  cx.arcTo(x + w, y + h, x, y + h, r);
  cx.arcTo(x, y + h, x, y, r);
  cx.arcTo(x, y, x + w, y, r);
  cx.closePath();
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function currentStmt() {
  if (!S.trace) return -1;
  if (S.stmtShown >= 0) return S.stmtShown;
  return clamp(S.model.stmt, 0, S.trace.statements.length - 1);
}


/* ---------- timeline ---------- */

const tlCv = $("#timeline");
const tlCx = tlCv.getContext("2d");

function buildTimeline() {
  S.timelineImg = null;
}

function renderTimelineImage(w, h, d) {
  const off = document.createElement("canvas");
  off.width = Math.round(w * d);
  off.height = Math.round(h * d);
  const cx = off.getContext("2d");
  cx.scale(d, d);
  const ev = S.trace.events;
  const n = ev.length;
  const bins = Math.max(1, Math.floor(w));
  const cat = [new Float32Array(bins), new Float32Array(bins), new Float32Array(bins), new Float32Array(bins)];
  for (let i = 0; i < n; i++) {
    const b = Math.min(bins - 1, Math.floor((i / n) * bins));
    const e = ev[i];
    if (e.k === "hit") cat[0][b] += 1 + (e.x || 0);
    else if (e.k === "load" || e.k === "miss") cat[1][b] += 1;
    else if (e.k === "evict" || e.k === "free") cat[2][b] += 1;
    else if (e.k === "batch") cat[3][b] += 1;
  }
  const colors = [C.cyan, C.amber, C.red, C.violet];
  const mid = h * 0.58;
  for (let c = 0; c < 4; c++) {
    let max = 1;
    for (const v of cat[c]) max = Math.max(max, v);
    for (let b = 0; b < bins; b++) {
      const v = cat[c][b];
      if (!v) continue;
      const a = Math.sqrt(v / max);
      cx.fillStyle = hexA(colors[c], 0.15 + 0.7 * a);
      const band = [[mid - 22, 22 * a], [mid, 12 * a], [mid + 12, 10 * a], [mid - 34, 10 * a]][c];
      if (c === 0) cx.fillRect(b, mid - band[1], 1, band[1]);
      else if (c === 3) cx.fillRect(b, mid - 24 - band[1], 1, band[1]);
      else cx.fillRect(b, band[0], 1, band[1]);
    }
  }
  return off;
}

function drawTimeline() {
  const { w, h, d } = fitCanvas(tlCv);
  const cx = tlCx;
  cx.setTransform(d, 0, 0, d, 0, 0);
  cx.clearRect(0, 0, w, h);
  cx.fillStyle = "rgba(0,0,0,0.3)";
  roundRect(cx, 0, 12, w, h - 16, 8);
  cx.fill();
  if (!S.trace || !S.trace.events.length) {
    cx.fillStyle = C.ink3;
    cx.font = `600 10px ${MONO}`;
    cx.textAlign = "center";
    cx.fillText("TIMELINE · run a query, then scrub through it", w / 2, h / 2 + 6);
    $("#clock").textContent = "";
    return;
  }
  if (!S.timelineImg || S.timelineImg.width !== Math.round(w * d)) S.timelineImg = renderTimelineImage(w, h, d);
  cx.drawImage(S.timelineImg, 0, 0, w, h);
  const n = S.trace.events.length;
  // statement boundaries
  cx.font = `700 9px ${MONO}`;
  cx.textAlign = "left";
  let labelEnd = -Infinity;
  S.trace.statements.forEach((st, i) => {
    const x = (st.events[0] / n) * w;
    cx.fillStyle = "rgba(255,43,214,0.5)";
    cx.fillRect(x, 12, 1, h - 16);
    cx.fillStyle = C.magenta;
    let label = `${i + 1} ${st.sql.split(/\s+/)[0].toUpperCase()}`;
    if (x + 4 < labelEnd) return;
    const next = i + 1 < S.trace.statements.length ? (S.trace.statements[i + 1].events[0] / n) * w : w;
    if (cx.measureText(label).width > next - x - 8) label = `${i + 1}`;
    cx.fillText(label, x + 4, 22);
    labelEnd = x + 8 + cx.measureText(label).width;
  });
  const x = (S.cursor / n) * w;
  cx.fillStyle = "rgba(0,240,255,0.06)";
  cx.fillRect(0, 12, x, h - 16);
  cx.strokeStyle = C.cyan;
  cx.shadowColor = C.cyan;
  cx.shadowBlur = 12;
  cx.lineWidth = 2;
  cx.beginPath(); cx.moveTo(x, 8); cx.lineTo(x, h - 2); cx.stroke();
  cx.shadowBlur = 0;
  cx.fillStyle = C.cyan;
  cx.beginPath(); cx.moveTo(x - 6, 4); cx.lineTo(x + 6, 4); cx.lineTo(x, 11); cx.fill();
  const us = S.applied > 0 ? S.trace.events[Math.min(S.applied, n) - 1].t : 0;
  $("#clock").textContent = `event ${fmt(S.applied)} / ${fmt(n)} · ${(us / 1000).toFixed(2)} ms engine time`;
}

let scrubbing = false;
function scrubTo(ev) {
  if (!S.trace) return;
  const r = tlCv.getBoundingClientRect();
  const k = clamp((ev.clientX - r.left) / r.width, 0, 1);
  S.playing = false;
  updatePlayButton();
  S.stmtShown = -1;
  seek(k * S.trace.events.length);
}
tlCv.addEventListener("pointerdown", (e) => { scrubbing = true; tlCv.setPointerCapture(e.pointerId); scrubTo(e); });
tlCv.addEventListener("pointermove", (e) => { if (scrubbing) scrubTo(e); });
tlCv.addEventListener("pointerup", () => { scrubbing = false; });

/* ---------- ticker ---------- */

let describing = 0;
function stmtAt(i) {
  const sts = S.trace.statements;
  for (let k = sts.length - 1; k >= 0; k--) if (sts[k].events[0] <= i) return k;
  return 0;
}

function opName(n) {
  const plan = S.plans[describing];
  const nd = plan && plan.byId.get(n);
  return nd ? `${nd.op}#${n}` : `#${n}`;
}

function describe(e) {
  const who = e.n != null ? opName(e.n) + " " : "";
  switch (e.k) {
    case "stmt": return ["s", `▸ statement ${e.i + 1}: ${S.trace.statements[e.i].sql.slice(0, 80)}`];
    case "open": return ["b", `${opName(e.n)} opens`];
    case "batch": return ["b", `${opName(e.n)} ⇡ ${e.rows} row${e.rows === 1 ? "" : "s"}`];
    case "done": return ["b", `${opName(e.n)} is exhausted`];
    case "close": return ["d", `${opName(e.n)} closes`];
    case "hit": return ["h", `${who}hit page ${e.p} in frame ${e.f}${e.x ? ` ×${e.x + 1}` : ""}${e.w ? " (write)" : ""}`];
    case "miss": return ["m", `${who}miss page ${e.p} → disk`];
    case "load":
      if (e.how === "new") return ["n", `${who}new page ${e.p} → frame ${e.f}`];
      if (e.how === "ghost") return ["m", `${who}ghost hit: page ${e.p} → frame ${e.f}, straight into T2`];
      return ["m", `${who}load page ${e.p} → frame ${e.f} (T1)`];
    case "lane": return ["d", e.to ? `page ${e.p} → ${e.to}` : `ARC forgets ghost page ${e.p}`];
    case "evict": return ["e", `evict page ${e.p} from frame ${e.f} → ghost ${e.to}`];
    case "unevict": return ["e", `undo eviction of page ${e.p}`];
    case "free": return ["n", `free page ${e.p}`];
    case "target": return ["n", `ARC target p → ${e.v}`];
    case "io": return [e.w ? "e" : "m", `disk ${e.w ? "write" : "read"} page ${e.p}`];
    case "kind": return ["d", `page ${e.p} is a ${e.kind} page${e.keys != null ? ` (${e.keys} keys)` : ""}`];
    case "owner": {
      const o = S.owners.find((x) => x.id === e.o);
      return ["d", `page ${e.p} belongs to ${o ? o.name : "?"}`];
    }
  }
  return ["d", e.k];
}

let tickerAt = -1;
function drawTicker() {
  if (!S.trace || tickerAt === S.applied) return;
  tickerAt = S.applied;
  const ev = S.trace.events;
  const lines = [];
  for (let i = S.applied - 1; i >= 0 && lines.length < 6; i--) {
    const e = ev[i];
    if (e.k === "owner" || e.k === "kind" || e.k === "close") continue;
    describing = stmtAt(i);
    lines.push(describe(e));
  }
  const el = $("#ticker");
  el.innerHTML = "";
  for (const [cls, text] of lines.reverse()) {
    const div = document.createElement("div");
    div.className = cls;
    div.textContent = text;
    el.appendChild(div);
  }
}

/* ---------- header meters, legend, results ---------- */

function drawMeters(t) {
  const m = S.model;
  if (!m) return;
  const base = S.trace ? S.trace.before.counters : m.counters;
  const hits = m.counters.hits - base.hits;
  const misses = m.counters.misses - base.misses;
  const total = hits + misses;
  const rate = total ? hits / total : null;
  $("#m-hits").textContent = fmt(hits);
  $("#m-misses").textContent = fmt(misses);
  $("#m-evict").textContent = fmt(m.counters.evictions - base.evictions);
  $("#m-io").textContent = `${fmt(m.counters.reads - base.reads)} / ${fmt(m.counters.writes - base.writes)}`;
  const si = currentStmt();
  $("#m-rows").textContent = fmt(si >= 0 ? m.rows[si] || 0 : 0);
  const ring = $("#m-hitrate");
  ring.querySelector(".fill").style.strokeDashoffset = String(94.25 * (1 - (rate || 0)));
  ring.querySelector(".fill").style.stroke = rate == null ? C.ink3 : rate > 0.8 ? C.green : rate > 0.5 ? C.amber : C.red;
  ring.querySelector("span").textContent = rate == null ? "–" : Math.round(rate * 100) + "%";
  $("#led-r").classList.toggle("on", t - S.ledR < 90);
  $("#led-w").classList.toggle("on", t - S.ledW < 90);
  const used = m.frames.filter((p) => p != null).length;
  $("#pool-meta").textContent = `${used}/${m.frames.length} frames in use · ${m.dirty.size} dirty`;
}

let legendKey = "";
function drawLegend() {
  const m = S.model;
  if (!m) return;
  const counts = new Map();
  for (const p of m.frames) if (p != null) { const o = m.owner.get(p); counts.set(o, (counts.get(o) || 0) + 1); }
  const key = [...counts.entries()].sort().join("|") + S.owners.length;
  if (key === legendKey) return;
  legendKey = key;
  const el = $("#legend");
  el.innerHTML = "";
  const shown = S.owners.filter((o) => counts.has(o.id) || o.kind !== "system");
  for (const o of shown) {
    const span = document.createElement("span");
    const i = document.createElement("i");
    const col = ownerColor(o.id);
    i.style.background = col;
    i.style.boxShadow = `0 0 8px ${col}`;
    span.appendChild(i);
    span.appendChild(document.createTextNode(o.name + " "));
    const em = document.createElement("em");
    em.textContent = `${o.kind === "table" ? "heap" : o.kind} · ${counts.get(o.id) || 0}`;
    span.appendChild(em);
    el.appendChild(span);
  }
  const glyphs = document.createElement("span");
  glyphs.innerHTML = '<em>▤ heap · H I L b+ header/internal/leaf · S spill · <b style="color:#ff2bd6">●</b> dirty</em>';
  el.appendChild(glyphs);
}

function renderStatements() {
  const el = $("#stmts");
  el.innerHTML = "";
  const sts = S.trace.statements;
  if (sts.length > 1) {
    sts.forEach((st, i) => {
      const b = document.createElement("button");
      b.textContent = `${i + 1} · ${st.sql.replace(/\s+/g, " ").slice(0, 28)}`;
      b.title = st.sql;
      if (st.outcome.kind === "error") b.classList.add("err");
      b.onclick = () => {
        S.playing = false;
        updatePlayButton();
        S.stmtShown = -1;
        seek(st.events[0]);
        seek(st.events[1]);
        S.stmtShown = i;
        S.rowsShown = -1;
      };
      el.appendChild(b);
    });
  }
  const total = S.trace.micros;
  $("#result-meta").textContent = `${sts.length} statement${sts.length === 1 ? "" : "s"} · ${(total / 1000).toFixed(1)} ms · ${fmt(S.trace.events.length)} events${S.trace.truncated ? " (trace cut short)" : ""}`;
  $("#txn").classList.toggle("hidden", !S.trace.in_transaction);
}

function resultStmt() {
  const sts = S.trace.statements;
  let si = currentStmt();
  if (S.stmtShown < 0 && !S.playing && S.applied >= S.trace.events.length) {
    for (let i = sts.length - 1; i >= 0; i--) if (sts[i].outcome.kind === "rows" || sts[i].outcome.kind === "error") { si = i; break; }
  }
  return si;
}

function drawResult() {
  if (!S.trace) return;
  const si = resultStmt();
  const st = S.trace.statements[si];
  if (!st) return;
  document.querySelectorAll("#stmts button").forEach((b, i) => b.classList.toggle("on", i === si));
  const done = S.model.stmt > si || S.applied >= st.events[1] || S.trace.events.length === 0;
  const el = $("#result");
  const o = st.outcome;
  if (o.kind === "rows") {
    const shown = done ? o.rows.length : Math.min(o.rows.length, S.model.rows[si] || 0);
    const key = si + ":" + shown;
    if (S.rowsShown === key) return;
    let table = el.querySelector("table");
    if (!table || table.dataset.stmt !== String(si)) {
      el.innerHTML = "";
      table = document.createElement("table");
      table.dataset.stmt = String(si);
      const tr = document.createElement("tr");
      for (const c of o.columns) { const th = document.createElement("th"); th.textContent = c; tr.appendChild(th); }
      const thead = document.createElement("thead");
      thead.appendChild(tr);
      table.appendChild(thead);
      table.appendChild(document.createElement("tbody"));
      el.appendChild(table);
      const more = document.createElement("div");
      more.className = "more";
      el.appendChild(more);
    }
    const tbody = table.querySelector("tbody");
    while (tbody.children.length > shown) tbody.removeChild(tbody.lastChild);
    const fresh = shown - tbody.children.length < 40;
    for (let r = tbody.children.length; r < shown; r++) {
      const tr = document.createElement("tr");
      if (fresh) tr.className = "fresh";
      for (const v of o.rows[r]) {
        const td = document.createElement("td");
        if (v == null) { td.textContent = "NULL"; td.className = "null"; } else td.textContent = v;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    const more = el.querySelector(".more");
    const outRows = done ? o.total : S.model.rows[si] || 0;
    more.textContent = o.total > o.rows.length && done
      ? `${fmt(o.total)} rows · showing the first ${fmt(o.rows.length)}`
      : `${fmt(outRows)} row${outRows === 1 ? "" : "s"}${done ? "" : " so far…"}`;
    S.rowsShown = key;
  } else {
    const key = si + ":" + o.kind + done;
    if (S.rowsShown === key) return;
    S.rowsShown = key;
    el.innerHTML = "";
    const div = document.createElement("div");
    div.className = "msg" + (o.kind === "error" ? " err" : "");
    if (!done) div.textContent = "running…";
    else if (o.kind === "count") div.textContent = `${o.op} ${fmt(o.rows)}`;
    else div.textContent = o.text;
    const small = document.createElement("small");
    small.textContent = `${(st.micros / 1000).toFixed(2)} ms`;
    div.appendChild(small);
    el.appendChild(div);
  }
}

/* ---------- editor ---------- */

const KEYWORDS = new Set(("select from where join on and or group by order limit insert into values update set delete create table index drop " +
  "begin commit rollback as asc desc inner left outer distinct partition over if exists not null int integer bigint float text varchar char boolean timestamp true false").split(" "));
const FUNCS = new Set(["count", "sum", "avg", "min", "max", "rank"]);

function highlight(src) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return src.replace(/('[^']*'?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|([=<>*+\-\/(),;.]+)|([^'A-Za-z0-9_=<>*+\-\/(),;.]+)/g,
    (m, str, num, word, op, rest) => {
      if (str) return `<span class="str">${esc(str)}</span>`;
      if (num) return `<span class="num">${num}</span>`;
      if (word) {
        const l = word.toLowerCase();
        if (KEYWORDS.has(l)) return `<span class="kw">${word}</span>`;
        if (FUNCS.has(l)) return `<span class="fn">${word}</span>`;
        return esc(word);
      }
      if (op) return `<span class="op">${esc(op)}</span>`;
      return esc(rest);
    }) + "\n";
}

const sqlEl = $("#sql");
const hlEl = $("#hl");
function syncEditor() {
  hlEl.innerHTML = highlight(sqlEl.value);
  hlEl.scrollTop = sqlEl.scrollTop;
}
sqlEl.addEventListener("input", syncEditor);
sqlEl.addEventListener("scroll", () => { hlEl.scrollTop = sqlEl.scrollTop; });
sqlEl.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); run(); }
  if (e.key === "Tab") {
    e.preventDefault();
    const s = sqlEl.selectionStart;
    sqlEl.setRangeText("  ", s, sqlEl.selectionEnd, "end");
    syncEditor();
  }
});

/* ---------- controls ---------- */

const batchEl = $("#batch");
function batchSize() { return BATCH_STEPS[+batchEl.value]; }
batchEl.value = String(BATCH_STEPS.indexOf(64));
batchEl.addEventListener("input", () => { $("#batch-v").textContent = String(batchSize()); });

function updatePlayButton() {
  $("#play").textContent = S.playing ? "❚❚" : "▶";
}

$("#play").addEventListener("click", togglePlay);
function togglePlay() {
  if (!S.trace) return;
  if (!S.playing && S.applied >= S.trace.events.length) { S.stmtShown = -1; seek(0); }
  S.stmtShown = -1;
  S.playing = !S.playing;
  updatePlayButton();
}
$("#restart").addEventListener("click", () => {
  if (!S.trace) return;
  S.stmtShown = -1;
  seek(0);
  S.playing = true;
  updatePlayButton();
});
document.addEventListener("keydown", (e) => {
  if (e.target === sqlEl) return;
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  if (e.key === "ArrowRight" && S.trace) { S.playing = false; updatePlayButton(); seek(S.cursor + Math.max(1, S.trace.events.length / 100)); }
  if (e.key === "ArrowLeft" && S.trace) { S.playing = false; updatePlayButton(); seek(S.cursor - Math.max(1, S.trace.events.length / 100)); }
});

function buildSpeeds() {
  const el = $("#speeds");
  for (const s of SPEEDS) {
    const b = document.createElement("button");
    b.textContent = s < 1 ? `${s}×` : `${s}×`;
    b.classList.toggle("on", s === S.speed);
    b.onclick = () => {
      S.speed = s;
      el.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    };
    el.appendChild(b);
  }
}

async function run() {
  if (S.busy) return;
  const sql = sqlEl.value.trim();
  if (!sql) return;
  S.busy = true;
  $("#run").classList.add("busy");
  try {
    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql, batch: batchSize() }),
    });
    if (!res.ok) throw new Error(await res.text());
    const trace = await res.json();
    loadTrace(trace);
    refreshSchema();
  } catch (err) {
    $("#result").innerHTML = "";
    const div = document.createElement("div");
    div.className = "msg err";
    div.textContent = String(err.message || err);
    $("#result").appendChild(div);
  } finally {
    S.busy = false;
    $("#run").classList.remove("busy");
  }
}
$("#run").addEventListener("click", run);

$("#reset").addEventListener("click", async () => {
  if (S.busy) return;
  S.busy = true;
  try {
    const res = await fetch("/api/reset", { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
    applyState(await res.json());
    S.trace = null;
    $("#result").innerHTML = '<div class="msg">fresh database loaded</div>';
    $("#stmts").innerHTML = "";
    $("#ticker").innerHTML = "";
  } catch (err) {
    $("#result").innerHTML = "";
    const div = document.createElement("div");
    div.className = "msg err";
    div.textContent = String(err.message || err);
    $("#result").appendChild(div);
  } finally {
    S.busy = false;
  }
});

function applyState(st) {
  S.frames = st.frames;
  S.ownerColor.clear();
  setOwners(st.owners);
  S.model = modelFrom(st.pool);
  scene.setFrames(st.frames);
  renderSchema(st);
  $("#engine-info").textContent = `cmudb · ${st.frames} frames · ARC · ${st.persistent ? "on disk" : "scratch db"}`;
  $("#txn").classList.toggle("hidden", !st.in_transaction);
}

function renderSchema(st) {
  const el = $("#schema");
  el.innerHTML = "";
  for (const t of st.tables) {
    const div = document.createElement("div");
    const b = document.createElement("b");
    b.textContent = t.name;
    div.appendChild(b);
    div.appendChild(document.createTextNode(` (${t.columns.map(([n]) => n).join(", ")})`));
    for (const ix of t.indexes) {
      const i = document.createElement("i");
      i.textContent = ` ⌗${ix}`;
      div.appendChild(i);
    }
    el.appendChild(div);
  }
}

async function refreshSchema() {
  try {
    const res = await fetch("/api/state");
    const st = await res.json();
    renderSchema(st);
  } catch (_) { /* the schema list is a convenience */ }
}


/* ---------- the 3D scene ---------- */

const scene = createScene({
  container: $("#stage"),
  colors: C,
  family: FAMILY,
  ownerColor,
  onPick(sel) { S.selection = sel; S.inspectKey = ""; },
  onHover(sel, x, y) {
    const tip = $("#tip");
    const text = sel ? describeSelection(sel) : null;
    if (!text) { tip.classList.add("hidden"); return; }
    tip.innerHTML = text;
    tip.style.left = x + "px";
    tip.style.top = y + "px";
    tip.classList.remove("hidden");
  },
});

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function planNode(id, stmt) {
  const plan = S.plans[stmt];
  return plan ? plan.byId.get(id) : null;
}

function nodeStats(id) {
  const si = currentStmt();
  const live = si === S.model.stmt;
  return (live || S.model.stmt > si ? S.model.nodes[si + ":" + id] : null) || { rows: 0, batches: 0, state: "idle", hits: 0, misses: 0, news: 0, path: [] };
}

function laneOf(p) {
  const i = S.model.lanes.findIndex((l) => l.includes(p));
  return i < 0 ? null : LANES[i];
}

const LANE_NAME = { T1: "T1 · seen once", T2: "T2 · seen again", B1: "B1 · ghost", B2: "B2 · ghost" };

function ownerOf(p) {
  const o = S.owners.find((x) => x.id === S.model.owner.get(p));
  return o || { name: "catalog", kind: "system", id: null };
}

function describeSelection(sel) {
  const m = S.model;
  if (!m) return null;
  if (sel.type === "frame") {
    const p = m.frames[sel.f];
    if (p == null) return `frame <b>${sel.f}</b> · empty`;
    return `frame <b>${sel.f}</b> · page <b>${p}</b> · ${escapeHtml(ownerOf(p).name)} ${m.kind.get(p) || ""}`;
  }
  if (sel.type === "page") {
    return `page <b>${sel.p}</b> · ${LANE_NAME[laneOf(sel.p)] || "gone"} · ${escapeHtml(ownerOf(sel.p).name)}`;
  }
  if (sel.type === "node") {
    const n = planNode(sel.id, sel.stmt);
    if (!n) return null;
    return `<b>${escapeHtml(n.op)}</b> · ${escapeHtml(n.title)} · ${fmt(nodeStats(sel.id).rows)} rows`;
  }
  if (sel.type === "disk") return `<b>disk</b> · ${fmt(m.counters.reads - (S.trace ? S.trace.before.counters.reads : m.counters.reads))} reads this run`;
  return null;
}

function kv(rows) {
  return "<dl>" + rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join("") + "</dl>";
}

function drawInspector() {
  const el = $("#inspect");
  const sel = S.selection;
  const m = S.model;
  let html;
  if (!sel || !m) {
    html = '<div class="idle">click a plan node, a frame, a lane page or the disk<br>drag to orbit · scroll to zoom · right drag to pan</div>';
  } else if (sel.type === "frame" || sel.type === "page") {
    const p = sel.type === "frame" ? m.frames[sel.f] : sel.p;
    const f = p == null ? sel.f : m.frames.indexOf(p);
    if (p == null) {
      html = `<h3 style="color:${C.ink3}">frame ${sel.f}</h3><h2>empty</h2><div class="detail">no page is loaded here right now</div>`;
    } else {
      const o = ownerOf(p);
      const color = ownerColor(o.id);
      const kind = m.kind.get(p);
      const keys = m.keys.get(p);
      html = `<h3 style="color:${color}">${f >= 0 ? `frame ${f} · ` : ""}${escapeHtml(o.kind)}</h3><h2>page ${p}</h2>` + kv([
        ["owner", escapeHtml(o.name)],
        ["page kind", escapeHtml(kind || "heap")],
        ...(keys != null ? [["keys", fmt(keys)]] : []),
        ["arc list", escapeHtml(LANE_NAME[laneOf(p)] || "none")],
        ["resident", f >= 0 ? `yes, frame ${f}` : "no"],
        ["dirty", m.dirty.has(p) ? '<span style="color:#ff2bd6">yes</span>' : "no"],
      ]);
    }
  } else if (sel.type === "node") {
    const n = planNode(sel.id, sel.stmt);
    if (!n || sel.stmt !== currentStmt()) {
      html = '<div class="idle">that plan belongs to another statement</div>';
    } else {
      const ns = nodeStats(sel.id);
      const color = FAMILY[n.family] || C.cyan;
      html = `<h3 style="color:${color}">${escapeHtml(n.op)} · node ${n.id}</h3><h2>${escapeHtml(n.title)}</h2>` +
        (n.detail.length ? `<div class="detail">${n.detail.map(escapeHtml).join("<br>")}</div>` : "") + kv([
          ["state", escapeHtml(ns.state)],
          ["rows out", fmt(ns.rows)],
          ["batches", fmt(ns.batches)],
          ["page hits", fmt(ns.hits)],
          ["page misses", fmt(ns.misses)],
          ["new pages", fmt(ns.news)],
        ]) + (ns.path.length ? '<div class="path">' + ns.path.map(([p, k]) =>
          `<span style="color:${k === "leaf" ? C.green : k === "internal" ? C.violet : C.cyan}">${k} ${p}</span>`).join("") + "</div>" : "");
    }
  } else if (sel.type === "disk") {
    const b = S.trace ? S.trace.before.counters : m.counters;
    html = `<h3 style="color:${C.violet}">disk manager</h3><h2>disk</h2>` + kv([
      ["reads this run", fmt(m.counters.reads - b.reads)],
      ["writes this run", fmt(m.counters.writes - b.writes)],
      ["pages allocated", fmt(m.counters.allocs - b.allocs)],
    ]);
  }
  if (html !== S.inspectHtml) { el.innerHTML = html; S.inspectHtml = html; }
}

/* ---------- camera buttons ---------- */

document.querySelectorAll("#views [data-view]").forEach((b) => {
  b.addEventListener("click", () => {
    scene.fly(b.dataset.view);
    document.querySelectorAll("#views [data-view]").forEach((x) => x.classList.toggle("on", x === b));
  });
});
$("#orbit").addEventListener("click", () => {
  scene.setAutoRotate(!scene.autoRotate);
  $("#orbit").classList.toggle("on", scene.autoRotate);
});

function insets() {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const rect = (sel) => { const el = $(sel); return el && el.offsetParent !== null ? el.getBoundingClientRect() : null; };
  const left = rect("#left");
  const right = rect("#right");
  const top = rect("#top");
  const bottom = rect("#bottom");
  const narrow = W < 1100;
  return {
    left: !narrow && left ? left.right : 0,
    right: !narrow && right ? W - right.left : 0,
    top: top ? top.bottom : 0,
    bottom: narrow ? H - (left ? left.top : H) : bottom ? H - bottom.top : 0,
  };
}

/* ---------- main loop ---------- */

function frame() {
  const t = now();
  const dt = Math.min(0.1, (t - S.lastTick) / 1000);
  S.lastTick = t;
  advance(dt);
  const si = currentStmt();
  const plan = si >= 0 ? S.plans[si] : null;
  if (S.planShown !== plan) {
    S.planShown = plan;
    scene.setPlan(plan, si);
  }
  const msg = $("#stage-msg");
  const st = S.trace && si >= 0 ? S.trace.statements[si] : null;
  if (!S.trace) { msg.textContent = "run a query to light up the plan"; msg.classList.remove("hidden"); }
  else if (st && !plan) {
    const kw = st.sql.trim().split(/\s+/)[0].toUpperCase();
    msg.textContent = `${kw} · ${st.outcome.kind === "error" ? "failed before it ran" : "runs without a plan tree"}`;
    msg.classList.remove("hidden");
  } else msg.classList.add("hidden");
  scene.setInsets(insets());
  scene.update(t, dt, S.model, nodeStats);
  drawTimeline();
  drawMeters(t);
  drawLegend();
  drawTicker();
  drawResult();
  drawInspector();
  requestAnimationFrame(frame);
}

window.addEventListener("resize", () => { S.timelineImg = null; });

async function boot() {
  buildSpeeds();
  const res = await fetch("/api/state");
  const st = await res.json();
  applyState(st);
  const ex = $("#examples");
  for (const e of st.examples) {
    const b = document.createElement("button");
    b.textContent = e.label;
    b.title = e.sql;
    b.onclick = () => { sqlEl.value = e.sql; syncEditor(); run(); };
    ex.appendChild(b);
  }
  const first = st.examples.find((e) => e.label === "hash join") || st.examples[0];
  sqlEl.value = first ? first.sql : "SELECT * FROM users;";
  syncEditor();
  scene.resize();
  requestAnimationFrame(frame);
  document.fonts.ready.then(() => scene.redrawCards());
  const params = new URLSearchParams(location.search);
  if (params.has("sql")) { sqlEl.value = params.get("sql"); syncEditor(); }
  if (params.has("speed")) S.speed = +params.get("speed");
  if (params.has("view")) {
    const b = document.querySelector(`#views [data-view="${params.get("view")}"]`);
    if (b) setTimeout(() => b.click(), 50);
  }
  if (params.has("orbit")) { scene.setAutoRotate(true); $("#orbit").classList.add("on"); }
  if (!params.has("norun")) setTimeout(run, 500);
}

boot();
