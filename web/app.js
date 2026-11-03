"use strict";

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
const SANS = '"Space Grotesk", ui-sans-serif, sans-serif';

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
  particles: [],
  flashes: [],
  beams: [],
  nodeHeat: new Map(),
  arcPos: new Map(),
  frameAnim: [],
  ledR: 0,
  ledW: 0,
  rowsShown: -1,
  lastTick: now(),
  busy: false,
  timelineImg: null,
  dirtyUI: true,
  hover: null,
  arcTarget: null,
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
  S.particles = [];
  S.flashes = [];
  S.beams = [];
  S.nodeHeat.clear();
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
    S.particles = [];
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
  const t = now();
  switch (e.k) {
    case "batch": {
      const plan = S.plans[S.model.stmt];
      if (!plan) break;
      const nd = plan.byId.get(e.n);
      if (!nd) break;
      if (S.particles.length < 420) S.particles.push({ n: e.n, rows: e.rows, t0: t, color: FAMILY[nd.family] || C.cyan, stmt: S.model.stmt });
      S.nodeHeat.set(S.model.stmt + ":" + e.n, t);
      break;
    }
    case "hit":
      S.flashes.push({ f: e.f, t0: t, color: e.w ? C.magenta : C.cyan, kind: "hit", strength: Math.min(1, 0.45 + (e.x || 0) * 0.08) });
      if (e.n != null) S.nodeHeat.set(S.model.stmt + ":" + e.n, t);
      break;
    case "load": {
      const color = e.how === "new" ? C.green : e.how === "ghost" ? C.violet : C.amber;
      S.flashes.push({ f: e.f, t0: t, color, kind: "load", strength: 1 });
      S.frameAnim[e.f] = { t0: t, kind: "in" };
      if (e.n != null && S.beams.length < 60) S.beams.push({ f: e.f, n: e.n, t0: t, color, stmt: S.model.stmt });
      break;
    }
    case "evict":
      S.flashes.push({ f: e.f, t0: t, color: C.red, kind: "evict", strength: 1, p: e.p, o: S.model.owner.get(e.p) });
      break;
    case "free":
      S.flashes.push({ f: -1, t0: t, color: SPILL_COLOR, kind: "free", strength: 1 });
      break;
    case "io":
      if (e.w) S.ledW = t; else S.ledR = t;
      break;
  }
}

/* ---------- plan layout and drawing ---------- */

const NODE_W = 216, NODE_H = 100, GAP_X = 26, GAP_Y = 60;

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
  const w = leaf * NODE_W + (leaf - 1) * GAP_X;
  const h = (depthMax + 1) * NODE_H + depthMax * GAP_Y;
  for (const n of nodes) {
    n.x = n.lx * (NODE_W + GAP_X);
    n.y = n.depth * (NODE_H + GAP_Y);
  }
  return { root, nodes, byId, parent, w, h };
}

const planCv = $("#plan");
const planCx = planCv.getContext("2d");
let planView = { scale: 1, ox: 0, oy: 0 };

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

function trunc(cx, text, max) {
  if (cx.measureText(text).width <= max) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cx.measureText(text.slice(0, mid) + "…").width <= max) lo = mid; else hi = mid - 1;
  }
  return text.slice(0, lo) + "…";
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function edgePoint(child, par, t) {
  const x0 = child.x + NODE_W / 2, y0 = child.y;
  const x1 = par.x + NODE_W / 2, y1 = par.y + NODE_H;
  const my = (y0 + y1) / 2;
  const u = 1 - t;
  const x = u * u * u * x0 + 3 * u * u * t * x0 + 3 * u * t * t * x1 + t * t * t * x1;
  const y = u * u * u * y0 + 3 * u * u * t * my + 3 * u * t * t * my + t * t * t * y1;
  return [x, y];
}

function currentStmt() {
  if (!S.trace) return -1;
  if (S.stmtShown >= 0) return S.stmtShown;
  return clamp(S.model.stmt, 0, S.trace.statements.length - 1);
}

function drawPlan(t) {
  const { w, h, d } = fitCanvas(planCv);
  const cx = planCx;
  cx.setTransform(d, 0, 0, d, 0, 0);
  cx.clearRect(0, 0, w, h);
  const si = currentStmt();
  const plan = si >= 0 ? S.plans[si] : null;
  $("#plan-empty").classList.toggle("hidden", !!S.trace);
  if (!S.trace) return;
  const st = S.trace.statements[si];
  if (!plan) {
    cx.textAlign = "center";
    cx.fillStyle = C.ink3;
    cx.font = `700 13px ${MONO}`;
    const kw = st ? st.sql.trim().split(/\s+/)[0].toUpperCase() : "";
    const why = st && st.outcome.kind === "error" ? "failed before it ran" : "runs without a plan tree";
    cx.fillText(`${kw} · ${why}`, w / 2, h / 2);
    return;
  }
  const pad = 28, top = 62;
  const scale = Math.min(1.15, (w - pad * 2) / plan.w, (h - top - pad) / plan.h);
  const ox = (w - plan.w * scale) / 2;
  const oy = top + Math.max(0, (h - top - pad - plan.h * scale) / 2) * 0.35;
  planView = { scale, ox, oy };
  cx.save();
  cx.translate(ox, oy);
  cx.scale(scale, scale);

  const m = S.model;
  const live = S.stmtShown < 0 || S.stmtShown === m.stmt;
  const stats = (n) => (live || m.stmt > si ? m.nodes[si + ":" + n] : null) || { rows: 0, batches: 0, state: "idle", hits: 0, misses: 0, news: 0, path: [] };

  // client sink above the root
  const root = plan.root;
  const sx = root.x + NODE_W / 2;
  const sinkY = -top / scale + 16;
  cx.strokeStyle = hexA(C.cyan, 0.25);
  cx.setLineDash([3, 5]);
  cx.lineWidth = 1.2 / scale;
  cx.beginPath(); cx.moveTo(sx, root.y); cx.lineTo(sx, sinkY + 10); cx.stroke();
  cx.setLineDash([]);
  cx.fillStyle = C.ink3;
  cx.font = `700 ${10 / scale}px ${MONO}`;
  cx.textAlign = "center";
  const rowsOut = m.rows[si] || 0;
  cx.fillText(`▲ CLIENT  ${fmt(live || m.stmt > si ? rowsOut : 0)} rows`, sx, sinkY);

  // edges
  for (const n of plan.nodes) {
    for (const c of n.children) {
      const cs = stats(c.id);
      const width = 1.2 + Math.log10(1 + cs.rows) * 1.1;
      const grad = cx.createLinearGradient(0, c.y, 0, n.y + NODE_H);
      const col = FAMILY[c.family] || C.cyan;
      grad.addColorStop(0, hexA(col, 0.55));
      grad.addColorStop(1, hexA(FAMILY[n.family] || C.cyan, 0.35));
      cx.strokeStyle = grad;
      cx.lineWidth = width;
      cx.beginPath();
      const x0 = c.x + NODE_W / 2, y0 = c.y, x1 = n.x + NODE_W / 2, y1 = n.y + NODE_H, my = (y0 + y1) / 2;
      cx.moveTo(x0, y0);
      cx.bezierCurveTo(x0, my, x1, my, x1, y1);
      cx.stroke();
      if (cs.rows > 0) {
        const [lx, ly] = edgePoint(c, n, 0.5);
        cx.font = `600 10px ${MONO}`;
        cx.textAlign = "left";
        cx.fillStyle = hexA(col, 0.9);
        cx.fillText(fmt(cs.rows), lx + 8, ly + 3);
      }
    }
  }

  // nodes
  for (const n of plan.nodes) {
    const ns = stats(n.id);
    const col = FAMILY[n.family] || C.cyan;
    const heat = S.nodeHeat.get(si + ":" + n.id);
    const hot = heat ? Math.max(0, 1 - (t - heat) / 650) : 0;
    const active = live && m.lastNode === n.id && S.playing;
    cx.save();
    if (hot > 0 || active) {
      cx.shadowColor = col;
      cx.shadowBlur = 10 + 28 * Math.max(hot, active ? 0.5 + 0.5 * Math.sin(t / 140) : 0);
    }
    roundRect(cx, n.x, n.y, NODE_W, NODE_H, 11);
    const bg = cx.createLinearGradient(n.x, n.y, n.x, n.y + NODE_H);
    bg.addColorStop(0, "rgba(16,26,52,0.97)");
    bg.addColorStop(1, "rgba(8,13,28,0.97)");
    cx.fillStyle = bg;
    cx.fill();
    cx.shadowBlur = 0;
    const idle = ns.state === "idle";
    cx.strokeStyle = hexA(col, idle ? 0.28 : 0.55 + 0.45 * hot);
    cx.lineWidth = 1.3;
    cx.stroke();
    cx.restore();
    // accent bar
    cx.fillStyle = hexA(col, idle ? 0.35 : 0.9);
    roundRect(cx, n.x, n.y + 10, 3, NODE_H - 20, 1.5);
    cx.fill();

    cx.textAlign = "left";
    cx.font = `800 10px ${MONO}`;
    cx.fillStyle = col;
    cx.fillText(n.op.toUpperCase(), n.x + 14, n.y + 19);
    cx.fillStyle = C.ink3;
    cx.textAlign = "right";
    cx.font = `600 9px ${MONO}`;
    const stateLabel = { idle: "", open: "OPEN", run: "", done: "✓ DONE" }[ns.state] || "";
    cx.fillStyle = ns.state === "done" ? hexA(C.green, 0.85) : C.ink3;
    cx.fillText(stateLabel || "#" + n.id, n.x + NODE_W - 10, n.y + 19);
    cx.textAlign = "left";
    cx.fillStyle = C.ink;
    cx.font = `600 12.5px ${SANS}`;
    cx.fillText(trunc(cx, n.title, NODE_W - 26), n.x + 14, n.y + 37);
    cx.fillStyle = C.ink3;
    cx.font = `400 10px ${MONO}`;
    cx.fillText(trunc(cx, n.detail.join(" · "), NODE_W - 26), n.x + 14, n.y + 52);
    // rows line
    cx.font = `800 15px ${MONO}`;
    cx.fillStyle = ns.rows ? C.ink : C.ink3;
    const rows = fmt(ns.rows);
    cx.fillText(rows, n.x + 14, n.y + 74);
    const rw = cx.measureText(rows).width;
    cx.font = `500 9.5px ${MONO}`;
    cx.fillStyle = C.ink3;
    cx.fillText(`rows out · ${ns.batches} batch${ns.batches === 1 ? "" : "es"}`, n.x + 18 + rw, n.y + 74);
    // pages line: the b+ tree path for index nodes, else hit/miss/new counts
    cx.font = `600 9.5px ${MONO}`;
    let px = n.x + 14;
    const put = (txt, c) => { cx.fillStyle = c; cx.fillText(txt, px, n.y + 90); px += cx.measureText(txt).width + 8; };
    if (ns.path.length) {
      put("b+", C.ink3);
      ns.path.forEach(([p, kind], i) => {
        if (i) { px -= 4; put("›", C.ink3); px -= 4; }
        put(`${KIND_GLYPH[kind]}${p}`, kind === "leaf" ? C.green : kind === "internal" ? C.violet : C.cyan);
      });
    } else if (ns.hits || ns.misses || ns.news) {
      const parts = [];
      if (ns.hits) parts.push([`●${fmt(ns.hits)}`, " hit", hexA(C.cyan, 0.85)]);
      if (ns.misses) parts.push([`▼${fmt(ns.misses)}`, " miss", hexA(C.amber, 0.9)]);
      if (ns.news) parts.push([`+${fmt(ns.news)}`, " new", hexA(C.green, 0.85)]);
      const wide = (words) => cx.measureText("pages " + parts.map((q) => q[0] + (words ? q[1] : "")).join("  ")).width;
      const words = wide(true) < NODE_W - 30;
      put("pages", C.ink3);
      for (const q of parts) put(q[0] + (words ? q[1] : ""), q[2]);
    } else {
      put(ns.state === "idle" ? "waiting" : "no page access", hexA(C.ink3, 0.7));
    }
    // heat bar
    if (hot > 0) {
      cx.fillStyle = hexA(col, 0.65 * hot);
      roundRect(cx, n.x + 12, n.y + NODE_H - 5, (NODE_W - 24) * hot, 2, 1);
      cx.fill();
    }
  }

  // particles: one per batch, child -> parent (root -> client)
  cx.globalCompositeOperation = "lighter";
  const travel = 620 / Math.sqrt(Math.max(0.25, S.speed));
  S.particles = S.particles.filter((p) => t - p.t0 < travel + 40);
  for (const p of S.particles) {
    if (p.stmt !== si) continue;
    const k = clamp((t - p.t0) / travel, 0, 1);
    const ease = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    const c = plan.byId.get(p.n);
    if (!c) continue;
    let x, y;
    const parId = plan.parent.get(p.n);
    if (parId == null) {
      x = c.x + NODE_W / 2;
      y = lerp(c.y, sinkY + 14, ease);
    } else {
      [x, y] = edgePoint(c, plan.byId.get(parId), ease);
    }
    const r = clamp(2.2 + Math.sqrt(p.rows) * 0.55, 2.2, 12);
    const fade = k > 0.85 ? (1 - k) / 0.15 : 1;
    const g = cx.createRadialGradient(x, y, 0, x, y, r * 2.6);
    g.addColorStop(0, hexA("#ffffff", 0.95 * fade));
    g.addColorStop(0.25, hexA(p.color, 0.85 * fade));
    g.addColorStop(1, hexA(p.color, 0));
    cx.fillStyle = g;
    cx.beginPath();
    cx.arc(x, y, r * 2.6, 0, Math.PI * 2);
    cx.fill();
  }
  cx.globalCompositeOperation = "source-over";
  cx.restore();
}

function nodeScreenCenter(n) {
  const plan = S.plans[S.model.stmt];
  if (!plan || currentStmt() !== S.model.stmt) return null;
  const nd = plan.byId.get(n);
  if (!nd) return null;
  const r = planCv.getBoundingClientRect();
  return [r.left + planView.ox + (nd.x + NODE_W / 2) * planView.scale, r.top + planView.oy + (nd.y + NODE_H / 2) * planView.scale];
}

/* ---------- buffer pool grid ---------- */

const poolCv = $("#pool");
const poolCx = poolCv.getContext("2d");
let poolGeom = null;

function poolLayout(w, h, n) {
  const pad = 14;
  const aw = w - pad * 2, ah = h - pad * 2;
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const size = Math.min(aw / cols, ah / rows);
    if (!best || size > best.size) best = { cols, rows, size };
  }
  const gap = Math.max(2, Math.round(best.size * 0.08));
  const cell = best.size - gap;
  const gw = best.cols * best.size - gap, gh = best.rows * best.size - gap;
  return { cols: best.cols, rows: best.rows, cell, step: best.size, ox: (w - gw) / 2, oy: (h - gh) / 2 };
}

function frameRect(f) {
  const g = poolGeom;
  const c = f % g.cols, r = Math.floor(f / g.cols);
  return [g.ox + c * g.step, g.oy + r * g.step, g.cell, g.cell];
}

const KIND_GLYPH = { heap: "▤", header: "H", internal: "I", leaf: "L", spill: "S", meta: "M" };

function drawPool(t) {
  const { w, h, d } = fitCanvas(poolCv);
  const cx = poolCx;
  cx.setTransform(d, 0, 0, d, 0, 0);
  cx.clearRect(0, 0, w, h);
  const m = S.model;
  if (!m) return;
  poolGeom = poolLayout(w, h, m.frames.length);
  const g = poolGeom;
  S.flashes = S.flashes.filter((f) => t - f.t0 < 700);
  const flashBy = new Map();
  for (const f of S.flashes) if (f.f >= 0) flashBy.set(f.f, f);
  const fontPx = clamp(g.cell * 0.26, 8, 15);
  for (let f = 0; f < m.frames.length; f++) {
    const [x, y, s] = frameRect(f);
    const p = m.frames[f];
    const fl = flashBy.get(f);
    const k = fl ? 1 - (t - fl.t0) / 700 : 0;
    const anim = S.frameAnim[f];
    let scale = 1;
    if (anim && anim.kind === "in") {
      const a = (t - anim.t0) / 380;
      if (a < 1) scale = 1 + 0.35 * Math.pow(1 - a, 3);
    }
    cx.save();
    cx.translate(x + s / 2, y + s / 2);
    cx.scale(scale, scale);
    const hx = -s / 2, hy = -s / 2;
    const r = Math.max(3, s * 0.14);
    if (p == null) {
      roundRect(cx, hx, hy, s, s, r);
      cx.fillStyle = "rgba(255,255,255,0.015)";
      cx.fill();
      cx.setLineDash([2, 3]);
      cx.strokeStyle = "rgba(142,162,200,0.16)";
      cx.lineWidth = 1;
      cx.stroke();
      cx.setLineDash([]);
    } else {
      const col = ownerColor(m.owner.get(p));
      if (fl && k > 0 && fl.kind !== "hit") {
        cx.shadowColor = fl.color;
        cx.shadowBlur = 22 * k * fl.strength;
      }
      roundRect(cx, hx, hy, s, s, r);
      const bg = cx.createLinearGradient(hx, hy, hx + s, hy + s);
      bg.addColorStop(0, hexA(col, 0.32));
      bg.addColorStop(1, hexA(col, 0.1));
      cx.fillStyle = bg;
      cx.fill();
      cx.shadowBlur = 0;
      cx.strokeStyle = hexA(col, 0.7);
      cx.lineWidth = 1.2;
      cx.stroke();
      if (fl && k > 0) {
        roundRect(cx, hx, hy, s, s, r);
        cx.strokeStyle = hexA(fl.color, 0.9 * k * fl.strength);
        cx.lineWidth = 2;
        cx.stroke();
        if (fl.kind !== "hit") {
          cx.fillStyle = hexA(fl.color, 0.13 * k * fl.strength);
          cx.fill();
        }
      }
      cx.fillStyle = "#f2f7ff";
      cx.textAlign = "center";
      cx.textBaseline = "middle";
      cx.font = `800 ${fontPx}px ${MONO}`;
      cx.fillText(String(p), 0, 1);
      if (s > 26) {
        const kind = m.kind.get(p);
        cx.font = `700 ${clamp(s * 0.17, 7, 11)}px ${MONO}`;
        cx.textAlign = "left";
        cx.textBaseline = "top";
        cx.fillStyle = hexA(col, 0.95);
        cx.fillText(KIND_GLYPH[kind] || "", hx + 4, hy + 3);
        const keys = m.keys.get(p);
        if ((kind === "leaf" || kind === "internal") && keys != null) {
          const frac = clamp(Math.log(1 + keys) / Math.log(1 + 600), 0.05, 1);
          cx.fillStyle = hexA(col, 0.18);
          cx.fillRect(hx + 4, hy + s - 6, s - 8, 2.5);
          cx.fillStyle = hexA(col, 0.95);
          cx.fillRect(hx + 4, hy + s - 6, (s - 8) * frac, 2.5);
        }
      }
      if (m.dirty.has(p)) {
        cx.fillStyle = C.magenta;
        cx.shadowColor = C.magenta;
        cx.shadowBlur = 6;
        cx.beginPath();
        cx.arc(hx + s - 5, hy + 5, 2.2, 0, Math.PI * 2);
        cx.fill();
        cx.shadowBlur = 0;
      }
    }
    if (fl && fl.kind === "evict" && k > 0) {
      const col = ownerColor(fl.o);
      cx.globalAlpha = k;
      cx.translate(0, -(1 - k) * s * 0.6);
      cx.scale(0.4 + 0.6 * k, 0.4 + 0.6 * k);
      roundRect(cx, hx, hy, s, s, r);
      cx.strokeStyle = hexA(C.red, 0.9);
      cx.lineWidth = 2;
      cx.stroke();
      cx.fillStyle = hexA(col, 0.25);
      cx.fill();
      cx.fillStyle = C.red;
      cx.textAlign = "center";
      cx.textBaseline = "middle";
      cx.font = `800 ${fontPx}px ${MONO}`;
      cx.fillText(String(fl.p), 0, 1);
      cx.globalAlpha = 1;
    }
    cx.restore();
    if (s > 30) {
      cx.fillStyle = "rgba(142,162,200,0.28)";
      cx.font = `600 ${clamp(s * 0.13, 7, 9)}px ${MONO}`;
      cx.textAlign = "right";
      cx.textBaseline = "alphabetic";
      cx.fillText("f" + f, x + s - 4, y + s - 3);
    }
  }
  cx.textBaseline = "alphabetic";
}

/* ---------- ARC lanes ---------- */

const arcCv = $("#arc");
const arcCx = arcCv.getContext("2d");

function drawArc(t, dt) {
  const { w, h, d } = fitCanvas(arcCv);
  const cx = arcCx;
  cx.setTransform(d, 0, 0, d, 0, 0);
  cx.clearRect(0, 0, w, h);
  const m = S.model;
  if (!m) return;
  const cap = m.frames.length;
  const pad = 16;
  const mid = w / 2;
  const slot = (w - pad * 2) / (2 * cap);
  const by = 40, bh = 34;
  cx.fillStyle = "rgba(255,255,255,0.025)";
  roundRect(cx, pad - 4, by - 6, w - 2 * pad + 8, bh + 12, 8);
  cx.fill();
  // resident window: the c frames centered on the split between T1 and T2
  cx.strokeStyle = "rgba(255,255,255,0.08)";
  cx.setLineDash([2, 4]);
  cx.beginPath();
  cx.moveTo(mid, by - 10); cx.lineTo(mid, by + bh + 10);
  cx.stroke();
  cx.setLineDash([]);
  // labels
  cx.font = `800 10px ${MONO}`;
  cx.textBaseline = "alphabetic";
  const counts = m.lanes.map((l) => l.length);
  const label = (txt, x, align, col) => { cx.textAlign = align; cx.fillStyle = col; cx.fillText(txt, x, 18); };
  label(`◁ B1 ghost ${counts[2]}`, pad, "left", hexA(C.violet, 0.85));
  label(`T1 recent ${counts[0]}`, mid - 8, "right", C.cyan);
  label(`${counts[1]} frequent T2`, mid + 8, "left", C.magenta);
  label(`${counts[3]} ghost B2 ▷`, w - pad, "right", hexA(C.amber, 0.85));
  // targets: where each page should sit
  const want = new Map();
  m.lanes[0].forEach((p, i) => want.set(p, [mid - (i + 1) * slot, 0]));
  m.lanes[1].forEach((p, i) => want.set(p, [mid + i * slot, 1]));
  m.lanes[2].forEach((p, i) => want.set(p, [mid - (counts[0] + i + 1) * slot, 2]));
  m.lanes[3].forEach((p, i) => want.set(p, [mid + (counts[1] + i) * slot, 3]));
  const ease = 1 - Math.pow(0.0005, dt);
  for (const [p, [x, lane]] of want) {
    const cur = S.arcPos.get(p);
    const nx = cur ? lerp(cur.x, x, ease) : x;
    S.arcPos.set(p, { x: nx, lane });
  }
  for (const p of [...S.arcPos.keys()]) if (!want.has(p)) S.arcPos.delete(p);
  const sw = Math.max(1, slot - (slot > 4 ? 1 : 0.3));
  for (const [p, { x, lane }] of S.arcPos) {
    const col = ownerColor(m.owner.get(p));
    if (x < pad - slot || x > w - pad + slot) continue;
    if (lane >= 2) {
      cx.fillStyle = hexA(col, 0.16);
      cx.fillRect(x, by + 8, sw, bh - 16);
      if (sw > 2.5) { cx.strokeStyle = hexA(col, 0.4); cx.lineWidth = 0.8; cx.strokeRect(x + 0.4, by + 8.4, sw - 0.8, bh - 16.8); }
    } else {
      cx.fillStyle = hexA(col, 0.8);
      cx.fillRect(x, by, sw, bh);
    }
  }
  // target p marker: where ARC wants T1 to end
  const tx = mid - m.target * slot;
  const shown = S.arcTarget == null ? tx : lerp(S.arcTarget, tx, ease);
  S.arcTarget = shown;
  cx.strokeStyle = C.green;
  cx.shadowColor = C.green;
  cx.shadowBlur = 10;
  cx.lineWidth = 2;
  cx.beginPath(); cx.moveTo(shown, by - 8); cx.lineTo(shown, by + bh + 8); cx.stroke();
  cx.shadowBlur = 0;
  cx.fillStyle = C.green;
  cx.beginPath(); cx.moveTo(shown - 5, by + bh + 14); cx.lineTo(shown + 5, by + bh + 14); cx.lineTo(shown, by + bh + 8); cx.fill();
  cx.font = `700 10px ${MONO}`;
  cx.textAlign = shown < w / 2 ? "left" : "right";
  cx.fillText(`target p = ${m.target}`, shown + (shown < w / 2 ? 8 : -8), by + bh + 24);
  if (Math.abs(shown - mid) > 120) {
    cx.fillStyle = C.ink3;
    cx.textAlign = "center";
    cx.font = `500 9.5px ${MONO}`;
    cx.fillText(`${cap} frames`, mid, by + bh + 24);
  }
}

/* ---------- overlay beams ---------- */

const ovCv = $("#overlay");
const ovCx = ovCv.getContext("2d");

function drawOverlay(t) {
  const { w, h, d } = fitCanvas(ovCv);
  const cx = ovCx;
  cx.setTransform(d, 0, 0, d, 0, 0);
  cx.clearRect(0, 0, w, h);
  if (!poolGeom) return;
  const pr = poolCv.getBoundingClientRect();
  const life = 700;
  S.beams = S.beams.filter((b) => t - b.t0 < life);
  cx.globalCompositeOperation = "lighter";
  for (const b of S.beams) {
    if (b.stmt !== S.model.stmt) continue;
    const to = nodeScreenCenter(b.n);
    if (!to) continue;
    const [fx, fy, s] = frameRect(b.f);
    const from = [pr.left + fx + s / 2, pr.top + fy + s / 2];
    const k = (t - b.t0) / life;
    const head = clamp(k * 1.6, 0, 1);
    const tail = clamp(k * 1.6 - 0.45, 0, 1);
    const ctrl = [(from[0] + to[0]) / 2, Math.min(from[1], to[1]) - 80];
    const pt = (u) => {
      const v = 1 - u;
      return [v * v * from[0] + 2 * v * u * ctrl[0] + u * u * to[0], v * v * from[1] + 2 * v * u * ctrl[1] + u * u * to[1]];
    };
    cx.strokeStyle = hexA(b.color, 0.55 * (1 - k));
    cx.lineWidth = 2;
    cx.beginPath();
    for (let u = tail; u <= head; u += 0.04) {
      const [x, y] = pt(u);
      if (u === tail) cx.moveTo(x, y); else cx.lineTo(x, y);
    }
    cx.stroke();
    const [hx, hy] = pt(head);
    const g = cx.createRadialGradient(hx, hy, 0, hx, hy, 10);
    g.addColorStop(0, hexA("#ffffff", 0.9 * (1 - k)));
    g.addColorStop(1, hexA(b.color, 0));
    cx.fillStyle = g;
    cx.beginPath(); cx.arc(hx, hy, 10, 0, Math.PI * 2); cx.fill();
  }
  cx.globalCompositeOperation = "source-over";
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

/* ---------- background ---------- */

function drawBackground() {
  const cv = $("#bg");
  const { w, h, d } = fitCanvas(cv);
  const cx = cv.getContext("2d");
  cx.setTransform(d, 0, 0, d, 0, 0);
  const g1 = cx.createRadialGradient(w * 0.15, h * 0.05, 0, w * 0.15, h * 0.05, w * 0.7);
  g1.addColorStop(0, "rgba(0,160,255,0.16)");
  g1.addColorStop(1, "rgba(0,0,0,0)");
  const g2 = cx.createRadialGradient(w * 0.9, h * 0.95, 0, w * 0.9, h * 0.95, w * 0.6);
  g2.addColorStop(0, "rgba(255,43,214,0.12)");
  g2.addColorStop(1, "rgba(0,0,0,0)");
  cx.fillStyle = "#04060d";
  cx.fillRect(0, 0, w, h);
  cx.fillStyle = g1; cx.fillRect(0, 0, w, h);
  cx.fillStyle = g2; cx.fillRect(0, 0, w, h);
  cx.strokeStyle = "rgba(120,170,255,0.045)";
  cx.lineWidth = 1;
  for (let x = 0; x < w; x += 32) { cx.beginPath(); cx.moveTo(x + 0.5, 0); cx.lineTo(x + 0.5, h); cx.stroke(); }
  for (let y = 0; y < h; y += 32) { cx.beginPath(); cx.moveTo(0, y + 0.5); cx.lineTo(w, y + 0.5); cx.stroke(); }
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

/* ---------- main loop ---------- */

function frame() {
  const t = now();
  const dt = Math.min(0.1, (t - S.lastTick) / 1000);
  S.lastTick = t;
  advance(dt);
  drawPlan(t);
  drawPool(t);
  drawArc(t, dt);
  drawOverlay(t);
  drawTimeline();
  drawMeters(t);
  drawLegend();
  drawTicker();
  drawResult();
  requestAnimationFrame(frame);
}

window.addEventListener("resize", () => { drawBackground(); S.timelineImg = null; });

async function boot() {
  drawBackground();
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
  requestAnimationFrame(frame);
  const params = new URLSearchParams(location.search);
  if (params.has("sql")) { sqlEl.value = params.get("sql"); syncEditor(); }
  if (params.has("speed")) S.speed = +params.get("speed");
  if (!params.has("norun")) setTimeout(run, 500);
}

boot();
