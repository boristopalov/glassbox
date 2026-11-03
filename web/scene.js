// The 3D world: the plan tree floating behind the buffer pool, the pool as a slab of frame
// tiles, ARC's lists as lanes in front of it and the disk below. app.js owns the replay model
// and calls into this module to draw it.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const MONO = '"JetBrains Mono", ui-monospace, monospace';
const SANS = '"Space Grotesk", ui-sans-serif, sans-serif';

const PITCH = 1.3;
const TILE = 1.04;
const TILE_H = 0.42;
const NODE_W = 3.9;
const NODE_H = 1.6;
const NODE_D = 0.34;
const NODE_DX = 4.7;
const NODE_DY = 2.7;
const DISK_Y = -7;
const FLOOR_Y = -10.5;
const MAX_PARTICLES = 900;
const MAX_BEAMS = 56;
const MAX_POPS = 48;
const LANE_ROWS = 4;
const KIND_GLYPH = { heap: "▤", header: "H", internal: "I", leaf: "L", spill: "S", meta: "M" };
const TREE_KINDS = new Set(["header", "internal", "leaf"]);

const ease = {
  outBack: (k) => { const c = 1.6; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); },
  inOut: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
  out: (k) => 1 - Math.pow(1 - k, 3),
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmt = (n) => Math.round(n).toLocaleString("en-US");

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
  let s = text;
  while (s.length > 1 && cx.measureText(s + "…").width > max) s = s.slice(0, -1);
  return s + "…";
}

function canvasTexture(w, h) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { canvas, cx: canvas.getContext("2d"), tex };
}

function glowTexture() {
  const { canvas, cx, tex } = canvasTexture(128, 128);
  const g = cx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,255,255,0.45)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  cx.fillStyle = g;
  cx.fillRect(0, 0, canvas.width, canvas.height);
  tex.needsUpdate = true;
  return tex;
}

/** A flat text label: a plane lying on the floor, or a sprite that always faces the camera. */
function textLabel(text, { color = "#8ea2c8", size = 0.5, weight = 700, font = MONO, flat = false } = {}) {
  const px = 64;
  const probe = document.createElement("canvas").getContext("2d");
  probe.font = `${weight} ${px}px ${font}`;
  const w = Math.ceil(probe.measureText(text).width) + 24;
  const { canvas, cx, tex } = canvasTexture(w, px + 24);
  const draw = (t, c) => {
    cx.clearRect(0, 0, canvas.width, canvas.height);
    cx.font = `${weight} ${px}px ${font}`;
    cx.fillStyle = c;
    cx.textBaseline = "middle";
    cx.fillText(t, 12, canvas.height / 2);
    tex.needsUpdate = true;
  };
  draw(text, color);
  const aspect = canvas.width / canvas.height;
  let obj;
  if (flat) {
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
    obj = new THREE.Mesh(new THREE.PlaneGeometry(size * aspect, size), mat);
    obj.rotation.x = -Math.PI / 2;
  } else {
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    obj = new THREE.Sprite(mat);
    obj.scale.set(size * aspect, size, 1);
  }
  obj.userData.redraw = draw;
  return obj;
}

export function createScene({ container, colors, family, ownerColor, onPick, onHover }) {
  const C = colors;
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#03050b");
  scene.fog = new THREE.FogExp2("#03050b", 0.0135);

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 400);
  camera.position.set(17, 15, 27);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 4;
  controls.maxDistance = 120;
  controls.maxPolarAngle = Math.PI * 0.72;
  controls.autoRotateSpeed = 0.55;
  controls.target.set(0, 2, -2);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.75, 0.5, 0.86);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  scene.add(new THREE.AmbientLight("#5a6fa8", 0.55));
  const key = new THREE.DirectionalLight("#cfe0ff", 1.5);
  key.position.set(8, 20, 14);
  scene.add(key);
  const cyanLight = new THREE.PointLight(C.cyan, 30, 40, 1.6);
  cyanLight.position.set(-12, 6, 8);
  scene.add(cyanLight);
  const magentaLight = new THREE.PointLight(C.magenta, 18, 40, 1.6);
  magentaLight.position.set(12, 4, -10);
  scene.add(magentaLight);

  const GLOW = glowTexture();
  const colorCache = new Map();
  const col = (hex) => {
    let c = colorCache.get(hex);
    if (!c) { c = new THREE.Color(hex); colorCache.set(hex, c); }
    return c;
  };

  /* ---------- the floor and dust ---------- */

  const grid = new THREE.GridHelper(240, 120, new THREE.Color("#1d3a6e"), new THREE.Color("#0c1a36"));
  grid.position.y = FLOOR_Y;
  grid.material.transparent = true;
  grid.material.opacity = 0.55;
  scene.add(grid);
  const floorGlow = new THREE.Mesh(
    new THREE.CircleGeometry(40, 64),
    new THREE.MeshBasicMaterial({ map: GLOW, color: "#0b3a7a", transparent: true, opacity: 0.55, depthWrite: false }),
  );
  floorGlow.rotation.x = -Math.PI / 2;
  floorGlow.position.y = FLOOR_Y + 0.02;
  scene.add(floorGlow);

  const dustGeo = new THREE.BufferGeometry();
  const dustPos = new Float32Array(900 * 3);
  for (let i = 0; i < 900; i++) {
    dustPos[i * 3] = (Math.random() - 0.5) * 110;
    dustPos[i * 3 + 1] = FLOOR_Y + Math.random() * 40;
    dustPos[i * 3 + 2] = (Math.random() - 0.5) * 110;
  }
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
    color: "#4fd8ff", size: 0.09, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, map: GLOW,
  }));
  scene.add(dust);

  /* ---------- world layout, rebuilt when the frame count changes ---------- */

  const world = new THREE.Group();
  scene.add(world);
  const L = { frames: 0, cols: 0, rows: 0, poolW: 0, poolD: 0, laneZ: 0, laneU: 0, planZ: 0, planTop: 0, planW: 0 };
  let tiles = [];
  let poolGroup = null;
  let disk = null;
  let lanes = null;

  function tileXZ(f) {
    const c = f % L.cols;
    const r = Math.floor(f / L.cols);
    return [(c - (L.cols - 1) / 2) * PITCH, (r - (L.rows - 1) / 2) * PITCH];
  }

  function buildPool(frames) {
    if (poolGroup) { world.remove(poolGroup); poolGroup.traverse((o) => { o.geometry?.dispose?.(); }); }
    if (disk) world.remove(disk.group);
    if (lanes) world.remove(lanes.group);
    L.frames = frames;
    L.cols = Math.ceil(Math.sqrt(frames));
    L.rows = Math.ceil(frames / L.cols);
    L.poolW = L.cols * PITCH;
    L.poolD = L.rows * PITCH;
    L.planZ = -(L.poolD / 2 + 7.5);
    L.laneZ = L.poolD / 2 + 3.6;

    poolGroup = new THREE.Group();
    world.add(poolGroup);
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(L.poolW + 1.1, 0.16, L.poolD + 1.1),
      new THREE.MeshStandardMaterial({ color: "#0a1430", emissive: "#06204a", emissiveIntensity: 0.55, roughness: 0.25, metalness: 0.7, transparent: true, opacity: 0.86 }),
    );
    plate.position.y = -0.1;
    poolGroup.add(plate);
    const plateEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(plate.geometry),
      new THREE.LineBasicMaterial({ color: col(C.cyan).clone().multiplyScalar(1.6), toneMapped: false, transparent: true, opacity: 0.8 }),
    );
    plateEdges.position.copy(plate.position);
    poolGroup.add(plateEdges);

    const sockets = [];
    for (let f = 0; f < frames; f++) {
      const [x, z] = tileXZ(f);
      const h = TILE / 2;
      const y = 0.002;
      sockets.push(x - h, y, z - h, x + h, y, z - h, x + h, y, z - h, x + h, y, z + h, x + h, y, z + h, x - h, y, z + h, x - h, y, z + h, x - h, y, z - h);
    }
    const sockGeo = new THREE.BufferGeometry();
    sockGeo.setAttribute("position", new THREE.Float32BufferAttribute(sockets, 3));
    poolGroup.add(new THREE.LineSegments(sockGeo, new THREE.LineBasicMaterial({ color: "#1f3c74", transparent: true, opacity: 0.8 })));

    const title = textLabel(`BUFFER POOL · ${frames} FRAMES`, { color: "#7fa0d8", size: 0.42, flat: true });
    title.position.set(-L.poolW / 2 - 0.5 + title.geometry.parameters.width / 2, -0.01, L.poolD / 2 + 1.05);
    poolGroup.add(title);

    const box = new THREE.BoxGeometry(TILE, TILE_H, TILE);
    const edgeGeo = new THREE.EdgesGeometry(box);
    const labelTiles = frames <= 400;
    tiles = [];
    for (let f = 0; f < frames; f++) {
      const [x, z] = tileXZ(f);
      const side = new THREE.MeshStandardMaterial({ color: "#11203f", emissive: "#000000", roughness: 0.35, metalness: 0.45, transparent: true });
      let top = side;
      let tex = null;
      if (labelTiles) {
        tex = canvasTexture(128, 128);
        top = new THREE.MeshStandardMaterial({ map: tex.tex, emissive: "#ffffff", emissiveMap: tex.tex, emissiveIntensity: 0.2, roughness: 0.5, transparent: true });
      }
      const mesh = new THREE.Mesh(box, [side, side, top, side, side, side]);
      mesh.userData.pick = { type: "frame", f };
      const edges = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: "#ffffff", toneMapped: false, transparent: true }));
      const group = new THREE.Group();
      group.add(mesh, edges);
      group.position.set(x, TILE_H / 2, z);
      group.visible = false;
      poolGroup.add(group);
      tiles.push({ f, x, z, group, mesh, side, top, edges, tex, page: null, key: "", base: col("#62739a"), flash: null, bump: 0, anim: null, mark: 0 });
    }

    buildDisk();
    buildLanes();
  }

  function buildDisk() {
    const group = new THREE.Group();
    group.position.y = DISK_Y;
    const r = Math.max(4.5, L.poolW * 0.42);
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(r, r, 0.7, 72, 1, false),
      new THREE.MeshStandardMaterial({ color: "#0b1226", emissive: "#120a2a", roughness: 0.2, metalness: 0.9 }),
    );
    group.add(body);
    const rings = [];
    for (let i = 0; i < 4; i++) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(r * (0.32 + i * 0.2), 0.03, 6, 96),
        new THREE.MeshBasicMaterial({ color: col(C.violet).clone().multiplyScalar(0.9), toneMapped: false, transparent: true, opacity: 0.7 }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.37;
      group.add(ring);
      rings.push(ring);
    }
    const head = new THREE.Mesh(new THREE.BoxGeometry(r * 0.9, 0.08, 0.22), new THREE.MeshStandardMaterial({ color: "#2a3a66", metalness: 0.9, roughness: 0.3 }));
    head.position.set(r * 0.4, 0.55, 0);
    group.add(head);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color: C.violet, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false }));
    halo.scale.set(r * 3.4, r * 1.6, 1);
    halo.position.y = 0.2;
    group.add(halo);
    const label = textLabel("DISK", { color: "#9b8bd8", size: 0.62 });
    label.position.set(0, -1.1, r + 0.4);
    group.add(label);
    body.userData.pick = { type: "disk" };
    world.add(group);
    disk = { group, body, rings, head, halo, r, pulse: 0, pulseColor: col(C.amber), reads: 0, writes: 0 };
  }

  function buildLanes() {
    const group = new THREE.Group();
    group.position.z = L.laneZ;
    const cap = Math.max(8, L.frames * 2 + 8);
    const cube = new THREE.BoxGeometry(1, 1, 1);
    const solid = new THREE.InstancedMesh(cube, new THREE.MeshBasicMaterial({ toneMapped: false }), cap);
    const ghost = new THREE.InstancedMesh(cube, new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 0.22, depthWrite: false }), cap);
    for (const m of [solid, ghost]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.setColorAt(0, new THREE.Color());
      m.count = 0;
      m.frustumCulled = false;
      group.add(m);
    }
    solid.userData.pick = { type: "lane" };
    ghost.userData.pick = { type: "lane" };
    const half = Math.ceil(L.frames / LANE_ROWS);
    L.laneU = clamp(Math.max(L.poolW * 0.62, 6.5) / half, 0.1, 0.7);
    const cacheW = half * L.laneU;
    const depth = LANE_ROWS * L.laneU * 1.12;
    const track = new THREE.Mesh(
      new THREE.BoxGeometry(cacheW * 3 + 2.4, 0.06, depth + 0.8),
      new THREE.MeshStandardMaterial({ color: "#0a1226", emissive: "#04122e", roughness: 0.3, metalness: 0.6, transparent: true, opacity: 0.8 }),
    );
    track.position.y = -0.05;
    group.add(track);
    const cacheBox = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(cacheW + 0.3, 0.02, depth + 0.4)),
      new THREE.LineBasicMaterial({ color: col(C.cyan).clone().multiplyScalar(1.4), toneMapped: false }),
    );
    group.add(cacheBox);
    const marker = new THREE.Group();
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.5, 0.05), new THREE.MeshBasicMaterial({ color: col(C.green).clone().multiplyScalar(2.2), toneMapped: false }));
    post.position.y = 0.75;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.3, 4), post.material);
    cone.rotation.x = Math.PI;
    cone.position.y = 1.6;
    const pLabel = textLabel("target p", { color: C.green, size: 0.32 });
    pLabel.position.y = 2.05;
    marker.add(post, cone, pLabel);
    group.add(marker);
    const mk = (t, x, color) => {
      const l = textLabel(t, { color, size: 0.34, flat: true });
      l.position.set(x, 0, depth / 2 + 0.85);
      group.add(l);
    };
    mk("B1 GHOSTS", -cacheW * 1.0 - 0.8, "#8f7ae0");
    mk("T1 · SEEN ONCE", -cacheW * 0.27, "#7fd8ff");
    mk("T2 · SEEN AGAIN", cacheW * 0.27, "#ff8ce9");
    mk("B2 GHOSTS", cacheW * 1.0 + 0.8, "#8f7ae0");
    world.add(group);
    lanes = { group, solid, ghost, marker, pos: new Map(), cacheW, order: { solid: [], ghost: [] }, markerX: 0 };
  }

  /* ---------- the plan tree ---------- */

  let plan = null;

  function cardTexture() {
    return canvasTexture(640, 262);
  }

  function setPlan(view, stmt) {
    if (plan) {
      world.remove(plan.group);
      plan.group.traverse((o) => {
        o.geometry?.dispose?.();
        if (o.material) for (const m of [].concat(o.material)) { m.map?.dispose?.(); m.dispose?.(); }
      });
    }
    plan = null;
    if (!view) return;
    const group = new THREE.Group();
    const nodes = new Map();
    let maxDepth = 0;
    let minLx = Infinity;
    let maxLx = -Infinity;
    for (const n of view.nodes) { maxDepth = Math.max(maxDepth, n.depth); minLx = Math.min(minLx, n.lx); maxLx = Math.max(maxLx, n.lx); }
    const midLx = (minLx + maxLx) / 2;
    const baseY = 1.6;
    for (const n of view.nodes) {
      const color = family[n.family] || C.cyan;
      const x = (n.lx - midLx) * NODE_DX;
      const y = baseY + (maxDepth - n.depth) * NODE_DY;
      const g = new THREE.Group();
      g.position.set(x, y, L.planZ);
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(NODE_W, NODE_H, NODE_D),
        new THREE.MeshStandardMaterial({ color: "#081024", emissive: color, emissiveIntensity: 0.08, roughness: 0.15, metalness: 0.75, transparent: true, opacity: 0.9 }),
      );
      slab.userData.pick = { type: "node", id: n.id, stmt };
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(slab.geometry),
        new THREE.LineBasicMaterial({ color: col(color).clone().multiplyScalar(1.5), toneMapped: false, transparent: true, opacity: 0.9 }),
      );
      const card = cardTexture();
      const face = new THREE.Mesh(
        new THREE.PlaneGeometry(NODE_W - 0.08, NODE_H - 0.08),
        new THREE.MeshBasicMaterial({ map: card.tex, transparent: true }),
      );
      face.position.z = NODE_D / 2 + 0.006;
      const back = face.clone();
      back.rotation.y = Math.PI;
      back.position.z = -NODE_D / 2 - 0.006;
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      halo.scale.set(NODE_W * 1.9, NODE_H * 2.6, 1);
      halo.position.z = -0.3;
      g.add(halo, slab, edges, face, back);
      group.add(g);
      nodes.set(n.id, { n, g, slab, edges, face, card, halo, color, heat: -1e9, key: "", drawn: 0, x, y });
    }
    const curves = new Map();
    const tubeFor = (from, to, color) => {
      const dy = to.y - from.y;
      const curve = new THREE.CubicBezierCurve3(from, new THREE.Vector3(from.x, from.y + dy * 0.55, from.z), new THREE.Vector3(to.x, to.y - dy * 0.55, to.z), to);
      const tube = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 40, 0.045, 8, false),
        new THREE.MeshBasicMaterial({ color: col(color).clone().multiplyScalar(0.75), toneMapped: false, transparent: true, opacity: 0.85 }),
      );
      group.add(tube);
      return curve;
    };
    for (const [id, nd] of nodes) {
      const parentId = view.parent.get(id);
      const parent = parentId == null ? null : nodes.get(parentId);
      const from = new THREE.Vector3(nd.x, nd.y + NODE_H / 2, L.planZ);
      if (parent) curves.set(id, tubeFor(from, new THREE.Vector3(parent.x, parent.y - NODE_H / 2, L.planZ), nd.color));
    }
    const root = nodes.get(view.root.id);
    const clientY = root.y + NODE_H / 2 + 2.4;
    const client = new THREE.Group();
    client.position.set(root.x, clientY, L.planZ);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.07, 12, 72), new THREE.MeshBasicMaterial({ color: col(C.cyan).clone().multiplyScalar(2), toneMapped: false }));
    const ring2 = new THREE.Mesh(new THREE.TorusGeometry(1.25, 0.02, 8, 72), new THREE.MeshBasicMaterial({ color: col(C.magenta).clone().multiplyScalar(1.8), toneMapped: false }));
    const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color: C.cyan, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
    core.scale.set(2.6, 2.6, 1);
    const clientLabel = textLabel("CLIENT · 0 rows", { color: "#9fe9ff", size: 0.4 });
    clientLabel.position.y = 1.75;
    client.add(core, ring, ring2, clientLabel);
    group.add(client);
    curves.set(view.root.id, tubeFor(new THREE.Vector3(root.x, root.y + NODE_H / 2, L.planZ), new THREE.Vector3(root.x, clientY - 0.9, L.planZ), root.color));
    world.add(group);
    L.planTop = clientY + 2;
    L.planW = (maxLx - minLx) * NODE_DX + NODE_W;
    plan = { rootId: view.root.id, group, nodes, curves, client, ring, ring2, core, clientLabel, clientRows: -1, stmt, pulse: 0 };
    if (!userMoved) fly(camView);
  }

  function drawCard(nd, ns, t) {
    const { cx, canvas, tex } = nd.card;
    const W = canvas.width;
    const H = canvas.height;
    const n = nd.n;
    cx.clearRect(0, 0, W, H);
    roundRect(cx, 4, 4, W - 8, H - 8, 22);
    cx.fillStyle = "rgba(6, 11, 26, 0.94)";
    cx.fill();
    cx.lineWidth = 3;
    cx.strokeStyle = nd.color;
    cx.globalAlpha = ns.state === "idle" ? 0.45 : 0.95;
    cx.stroke();
    cx.globalAlpha = 1;
    cx.fillStyle = nd.color;
    cx.fillRect(4, 30, 7, H - 60);
    cx.textBaseline = "alphabetic";
    cx.font = `800 26px ${MONO}`;
    cx.fillStyle = nd.color;
    cx.fillText(n.op.toUpperCase(), 32, 50);
    cx.textAlign = "right";
    cx.font = `700 22px ${MONO}`;
    if (ns.state === "done") { cx.fillStyle = C.green; cx.fillText("✓ DONE", W - 28, 50); }
    else if (ns.state === "run" || ns.state === "open") { cx.fillStyle = "#ffffff"; cx.fillText("● LIVE", W - 28, 50); }
    else { cx.fillStyle = "#4f6187"; cx.fillText(`#${n.id}`, W - 28, 50); }
    cx.textAlign = "left";
    cx.font = `700 36px ${SANS}`;
    cx.fillStyle = "#e8f0ff";
    cx.fillText(trunc(cx, n.title || n.op, W - 64), 32, 96);
    cx.font = `500 21px ${MONO}`;
    cx.fillStyle = "#5d6f96";
    cx.fillText(trunc(cx, (n.detail || []).join(" · "), W - 64), 32, 128);
    cx.font = `800 44px ${MONO}`;
    cx.fillStyle = ns.rows ? "#ffffff" : "#4f6187";
    const rows = fmt(ns.rows);
    cx.fillText(rows, 32, 184);
    const rw = cx.measureText(rows).width;
    cx.font = `500 22px ${MONO}`;
    cx.fillStyle = "#7d8fb8";
    cx.fillText(`rows out · ${ns.batches} batch${ns.batches === 1 ? "" : "es"}`, 44 + rw, 184);
    cx.font = `700 22px ${MONO}`;
    let px = 32;
    const put = (s, c) => { cx.fillStyle = c; cx.fillText(s, px, 226); px += cx.measureText(s).width + 16; };
    if (ns.path && ns.path.length) {
      put("b+", "#5d6f96");
      ns.path.forEach(([p, kind], i) => {
        if (i) { px -= 8; put("›", "#5d6f96"); px -= 8; }
        put(`${KIND_GLYPH[kind]}${p}`, kind === "leaf" ? C.green : kind === "internal" ? C.violet : C.cyan);
      });
    } else if (ns.hits || ns.misses || ns.news) {
      put("pages", "#5d6f96");
      if (ns.hits) put(`●${fmt(ns.hits)} hit`, C.cyan);
      if (ns.misses) put(`▼${fmt(ns.misses)} miss`, C.amber);
      if (ns.news) put(`+${fmt(ns.news)} new`, C.green);
    } else {
      put(ns.state === "idle" ? "waiting" : "no page access", "#3c4a6c");
    }
    const heat = clamp(1 - (t - nd.heat) / 600, 0, 1);
    if (heat > 0) {
      cx.globalAlpha = heat;
      cx.fillStyle = nd.color;
      cx.fillRect(32, H - 22, (W - 64) * heat, 4);
      cx.globalAlpha = 1;
    }
    tex.needsUpdate = true;
  }

  /* ---------- particles, beams and pops ---------- */

  const pMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshBasicMaterial({ toneMapped: false }), MAX_PARTICLES);
  pMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  pMesh.setColorAt(0, new THREE.Color());
  pMesh.frustumCulled = false;
  pMesh.count = 0;
  scene.add(pMesh);
  let particles = [];

  function spark(curve, color, size, dur, trail = 3, onArrive = null) {
    if (particles.length > 260) particles.shift();
    particles.push({ curve, color: col(color).clone().multiplyScalar(2.4), size, t0: performance.now(), dur, trail, onArrive });
  }

  const beams = [];
  for (let i = 0; i < MAX_BEAMS; i++) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(33 * 3), 3));
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ toneMapped: false, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    line.visible = false;
    line.frustumCulled = false;
    scene.add(line);
    beams.push({ line, t0: 0, dur: 1 });
  }
  let beamNext = 0;

  function beam(curve, color, dur = 900) {
    const b = beams[beamNext++ % MAX_BEAMS];
    const pts = curve.getPoints(32);
    const arr = b.line.geometry.attributes.position.array;
    pts.forEach((p, i) => { arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z; });
    b.line.geometry.attributes.position.needsUpdate = true;
    b.line.material.color.copy(col(color)).multiplyScalar(2.2);
    b.t0 = performance.now();
    b.dur = dur;
    b.line.visible = true;
  }

  const pops = [];
  const popGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(TILE, TILE_H, TILE));
  for (let i = 0; i < MAX_POPS; i++) {
    const m = new THREE.LineSegments(popGeo, new THREE.LineBasicMaterial({ toneMapped: false, transparent: true, opacity: 0 }));
    m.visible = false;
    scene.add(m);
    pops.push({ m, t0: 0 });
  }
  let popNext = 0;

  function pop(x, y, z, color) {
    const p = pops[popNext++ % MAX_POPS];
    p.m.position.set(x, y, z);
    p.m.material.color.copy(col(color)).multiplyScalar(2.5);
    p.t0 = performance.now();
    p.m.visible = true;
  }

  const pathLine = new THREE.Line(
    new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array(6 * 25 * 3), 3)),
    new THREE.LineBasicMaterial({ color: col(C.green).clone().multiplyScalar(2.6), toneMapped: false }),
  );
  pathLine.frustumCulled = false;
  pathLine.visible = false;
  scene.add(pathLine);

  /* ---------- geometry helpers for effects ---------- */

  const tileTop = (f) => {
    const t = tiles[f];
    return new THREE.Vector3(t.x, TILE_H + 0.05, t.z);
  };
  const nodeBottom = (id) => {
    const nd = plan && plan.nodes.get(id);
    return nd ? new THREE.Vector3(nd.x, nd.y - NODE_H / 2, L.planZ + NODE_D / 2) : null;
  };
  const arc = (a, b, lift) => {
    const mid = a.clone().lerp(b, 0.5);
    mid.y = Math.max(a.y, b.y) + lift;
    return new THREE.QuadraticBezierCurve3(a, mid, b);
  };
  const diskPoint = () => {
    const ang = Math.random() * Math.PI * 2;
    const rr = Math.random() * disk.r * 0.8;
    return new THREE.Vector3(Math.cos(ang) * rr, DISK_Y + 0.4, Math.sin(ang) * rr);
  };
  const straight = (a, b) => new THREE.LineCurve3(a, b);

  function heat(id, t) {
    const nd = plan && plan.nodes.get(id);
    if (nd) nd.heat = t;
  }

  /* ---------- reacting to trace events ---------- */

  function effect(e, model) {
    const t = performance.now();
    switch (e.k) {
      case "batch": {
        if (!plan) break;
        const curve = plan.curves.get(e.n);
        const nd = plan.nodes.get(e.n);
        if (!curve || !nd) break;
        heat(e.n, t);
        const size = clamp(0.1 + 0.035 * Math.log2(e.rows + 1), 0.1, 0.34);
        const isRoot = e.n === plan.rootId;
        spark(curve, nd.color, size, 820, 4, isRoot ? () => { plan && (plan.pulse = performance.now()); } : null);
        break;
      }
      case "hit": {
        const tile = tiles[e.f];
        if (tile) {
          tile.flash = { t0: t, color: col(e.w ? C.magenta : C.cyan), strength: Math.min(1, 0.5 + (e.x || 0) * 0.06), dur: 520 };
          tile.bump = t;
        }
        if (e.n != null) heat(e.n, t);
        break;
      }
      case "load": {
        const tile = tiles[e.f];
        if (!tile) break;
        const color = e.how === "new" ? C.green : e.how === "ghost" ? C.violet : C.amber;
        tile.flash = { t0: t, color: col(color), strength: 1, dur: 900 };
        tile.anim = { t0: t, from: e.how === "new" ? 1.6 : -1.8 };
        if (e.how !== "new" && disk) {
          spark(arc(diskPoint(), tileTop(e.f), 1.2), color, 0.13, 620, 3);
          disk.pulse = t;
          disk.pulseColor = col(color);
        } else {
          pop(tile.x, TILE_H / 2, tile.z, C.green);
        }
        if (e.n != null) {
          heat(e.n, t);
          const nb = nodeBottom(e.n);
          if (nb) {
            const curve = arc(tileTop(e.f), nb, 2.2);
            beam(curve, color, 1000);
            spark(curve, color, 0.11, 700, 2);
          }
        }
        break;
      }
      case "evict": {
        const tile = tiles[e.f];
        if (!tile) break;
        pop(tile.x, TILE_H / 2 + 0.05, tile.z, C.red);
        tile.flash = { t0: t, color: col(C.red), strength: 1, dur: 600 };
        break;
      }
      case "free":
        if (disk) { disk.pulse = t; disk.pulseColor = col("#ff8a3d"); }
        break;
      case "io": {
        if (!disk) break;
        disk.pulse = t;
        disk.pulseColor = col(e.w ? C.magenta : C.amber);
        if (e.w) {
          const f = model.frames.indexOf(e.p);
          if (f >= 0) spark(arc(tileTop(f), diskPoint(), 0.6), C.magenta, 0.12, 640, 3);
        }
        break;
      }
    }
  }

  function clearEffects() {
    particles = [];
    for (const b of beams) b.line.visible = false;
    for (const p of pops) p.m.visible = false;
    for (const tile of tiles) { tile.flash = null; tile.anim = null; }
  }

  /* ---------- per-frame update ---------- */

  const dummy = new THREE.Object3D();
  const tmpColor = new THREE.Color();
  let autoRotate = false;
  let tween = null;
  let camView = "overview";
  let userMoved = false;
  let selected = null;
  let hovered = null;

  function drawTileTop(tile, page, kind, keys, color, dirty) {
    if (!tile.tex) return;
    const { cx, canvas, tex } = tile.tex;
    const W = canvas.width;
    cx.clearRect(0, 0, W, W);
    cx.fillStyle = "#0b1226";
    cx.fillRect(0, 0, W, W);
    const g = cx.createLinearGradient(0, 0, W, W);
    g.addColorStop(0, color + "88");
    g.addColorStop(1, color + "30");
    cx.fillStyle = g;
    cx.fillRect(0, 0, W, W);
    cx.strokeStyle = color;
    cx.lineWidth = 6;
    cx.strokeRect(3, 3, W - 6, W - 6);
    cx.fillStyle = "#ffffff";
    cx.textAlign = "center";
    cx.textBaseline = "middle";
    const label = String(page);
    cx.font = `800 ${label.length > 4 ? 30 : label.length > 3 ? 36 : 44}px ${MONO}`;
    cx.fillText(label, W / 2, W / 2 + 6);
    cx.textAlign = "left";
    cx.font = `800 22px ${MONO}`;
    cx.fillStyle = color;
    cx.fillText(KIND_GLYPH[kind] || "·", 12, 22);
    if (dirty) {
      cx.fillStyle = C.magenta;
      cx.beginPath();
      cx.arc(W - 18, 18, 8, 0, Math.PI * 2);
      cx.fill();
    }
    if (keys != null && TREE_KINDS.has(kind) && kind !== "header") {
      cx.fillStyle = "rgba(255,255,255,0.12)";
      cx.fillRect(14, W - 20, W - 28, 7);
      cx.fillStyle = color;
      cx.fillRect(14, W - 20, (W - 28) * clamp(keys / 64, 0.04, 1), 7);
    }
    tex.needsUpdate = true;
  }

  function updateTiles(model, t) {
    let pathActive = selected && selected.type === "frame" ? selected.f : -1;
    for (const tile of tiles) {
      const page = model.frames[tile.f];
      if (page == null) {
        if (tile.page != null) tile.page = null;
        if (!tile.anim) tile.group.visible = false;
      } else {
        const owner = model.owner.get(page);
        const kind = model.kind.get(page);
        const keys = model.keys.get(page);
        const dirty = model.dirty.has(page);
        const color = ownerColor(owner);
        const key = `${page}|${color}|${kind}|${keys}|${dirty}`;
        if (key !== tile.key) {
          tile.key = key;
          tile.page = page;
          tile.base = col(color);
          tile.side.color.copy(tile.base).multiplyScalar(0.28);
          drawTileTop(tile, page, kind, keys, color, dirty);
        }
        tile.group.visible = true;
      }
      let y = TILE_H / 2;
      let opacity = 1;
      if (tile.anim) {
        const k = clamp((t - tile.anim.t0) / 480, 0, 1);
        y += tile.anim.from * (1 - ease.outBack(k));
        opacity = Math.min(1, 0.15 + k * 1.4);
        if (k >= 1) tile.anim = null;
        if (page == null) tile.group.visible = false;
      }
      const bump = clamp(1 - (t - tile.bump) / 260, 0, 1);
      y += bump * 0.16;
      tile.group.position.y = y;
      tile.side.opacity = 0.92 * opacity;
      if (tile.top !== tile.side) tile.top.opacity = opacity;
      let glow = 0;
      let glowColor = tile.base;
      if (tile.flash) {
        const k = 1 - (t - tile.flash.t0) / tile.flash.dur;
        if (k <= 0) tile.flash = null;
        else { glow = k * k * tile.flash.strength; glowColor = tile.flash.color; }
      }
      tile.side.emissive.copy(tile.base).lerp(glowColor, glow > 0 ? 1 : 0).multiplyScalar(0.1 + glow * 2.2);
      const isSel = pathActive === tile.f;
      const isHover = hovered && hovered.type === "frame" && hovered.f === tile.f;
      const mark = tile.mark;
      tile.edges.material.color.copy(isSel ? tmpColor.set("#ffffff") : mark ? col(C.green) : glow > 0 ? glowColor : tile.base)
        .multiplyScalar(isSel ? 2.4 : mark ? 2.4 : isHover ? 2 : 0.9 + glow * 2);
      tile.edges.material.opacity = opacity;
      if (tile.top !== tile.side) tile.top.emissiveIntensity = 0.2 + glow * 0.25 + (mark ? 0.4 : 0);
    }
  }

  function updateLanes(model, dt) {
    if (!lanes) return;
    const u = L.laneU;
    const half = Math.ceil(L.frames / LANE_ROWS);
    const left = -(half * u) / 2;
    const right = (half * u) / 2;
    const [T1, T2, B1, B2] = model.lanes;
    const t1Cols = Math.ceil(T1.length / LANE_ROWS);
    const split = left + t1Cols * u;
    const want = new Map();
    const slot = (i) => [Math.floor(i / LANE_ROWS), (i % LANE_ROWS) - (LANE_ROWS - 1) / 2];
    T1.forEach((p, i) => { const [c, r] = slot(i); want.set(p, [split - (c + 0.5) * u, r * u * 1.12, 0]); });
    T2.forEach((p, i) => { const [c, r] = slot(i); want.set(p, [split + (c + 0.5) * u, r * u * 1.12, 1]); });
    B1.forEach((p, i) => { const [c, r] = slot(i); want.set(p, [left - 0.9 - (c + 0.5) * u, r * u * 1.12, 2]); });
    B2.forEach((p, i) => { const [c, r] = slot(i); want.set(p, [right + 0.9 + (c + 0.5) * u, r * u * 1.12, 3]); });
    const k = 1 - Math.exp(-dt * 14);
    const pos = lanes.pos;
    for (const p of pos.keys()) if (!want.has(p)) pos.delete(p);
    let si = 0;
    let gi = 0;
    lanes.order.solid.length = 0;
    lanes.order.ghost.length = 0;
    const size = u * 0.64;
    for (const [p, [x, z, lane]] of want) {
      let cur = pos.get(p);
      if (!cur) {
        const f = model.frames.indexOf(p);
        cur = f >= 0 && tiles[f] ? { x: tiles[f].x, y: 0.4, z: tiles[f].z - L.laneZ } : { x, y: 2.5, z };
        pos.set(p, cur);
      }
      cur.x += (x - cur.x) * k;
      cur.z += (z - cur.z) * k;
      cur.y += (size / 2 + 0.02 - cur.y) * k;
      const ghost = lane >= 2;
      dummy.position.set(cur.x, cur.y, cur.z);
      dummy.scale.setScalar(size);
      dummy.updateMatrix();
      const mesh = ghost ? lanes.ghost : lanes.solid;
      const i = ghost ? gi++ : si++;
      mesh.setMatrixAt(i, dummy.matrix);
      const sel = selected && selected.type === "page" && selected.p === p;
      tmpColor.copy(col(ownerColor(model.owner.get(p)))).multiplyScalar(sel ? 3 : ghost ? 1.2 : 1.05);
      mesh.setColorAt(i, tmpColor);
      (ghost ? lanes.order.ghost : lanes.order.solid).push(p);
    }
    lanes.solid.count = si;
    lanes.ghost.count = gi;
    for (const m of [lanes.solid, lanes.ghost]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    const mx = left + (model.target / LANE_ROWS) * u;
    lanes.markerX += (mx - lanes.markerX) * k;
    lanes.marker.position.x = lanes.markerX;
  }

  function updatePlan(t, stats, model) {
    if (!plan) return;
    let pathNode = null;
    let pathHeat = -1;
    for (const [id, nd] of plan.nodes) {
      const ns = stats(id);
      const h = clamp(1 - (t - nd.heat) / 650, 0, 1);
      const live = ns.state === "run" || ns.state === "open";
      const pathKey = ns.path ? ns.path.map((q) => q.join("")).join(",") : "";
      const key = `${ns.rows}|${ns.batches}|${ns.state}|${ns.hits}|${ns.misses}|${ns.news}|${pathKey}|${h > 0 ? Math.round(h * 8) : 0}`;
      if (key !== nd.key && t - nd.drawn > 70) { nd.key = key; nd.drawn = t; drawCard(nd, ns, t); }
      const sel = selected && selected.type === "node" && selected.id === id;
      const hov = hovered && hovered.type === "node" && hovered.id === id;
      nd.halo.material.opacity = 0.04 + h * 0.32 + (live ? 0.06 : 0) + (sel ? 0.2 : 0);
      nd.slab.material.emissiveIntensity = 0.08 + h * 0.5 + (live ? 0.1 : 0);
      nd.edges.material.color.copy(sel ? tmpColor.set("#ffffff") : col(nd.color)).multiplyScalar(sel ? 2.4 : hov ? 2.6 : 1.2 + h * 1.6);
      const s = 1 + h * 0.035;
      nd.g.scale.set(s, s, s);
      if (ns.path && ns.path.length && ns.state !== "idle" && nd.heat > pathHeat) { pathNode = ns; pathHeat = nd.heat; }
    }
    plan.ring.rotation.z += 0.012;
    plan.ring2.rotation.y += 0.008;
    plan.ring2.rotation.x = Math.sin(t / 1400) * 0.4;
    const pulse = clamp(1 - (t - plan.pulse) / 400, 0, 1);
    plan.core.material.opacity = 0.35 + pulse * 0.6;
    plan.core.scale.setScalar(2.6 + pulse * 1.2);
    const rows = model.rows[plan.stmt] || 0;
    if (rows !== plan.clientRows) {
      plan.clientRows = rows;
      plan.clientLabel.userData.redraw(`CLIENT · ${fmt(rows)} row${rows === 1 ? "" : "s"}`, "#9fe9ff");
    }
    return pathNode;
  }

  function updatePath(pathNode, model) {
    for (const tile of tiles) tile.mark = 0;
    if (!pathNode) { pathLine.visible = false; return; }
    const pts = [];
    for (const [p] of pathNode.path) {
      const f = model.frames.indexOf(p);
      if (f >= 0) { tiles[f].mark = 1; pts.push(tileTop(f)); }
    }
    if (pts.length < 2) { pathLine.visible = false; return; }
    const arr = pathLine.geometry.attributes.position.array;
    let k = 0;
    for (let i = 0; i + 1 < pts.length && i < 6; i++) {
      const c = arc(pts[i], pts[i + 1], 1.4);
      for (const q of c.getPoints(24)) { arr[k++] = q.x; arr[k++] = q.y; arr[k++] = q.z; }
    }
    pathLine.geometry.setDrawRange(0, k / 3);
    pathLine.geometry.attributes.position.needsUpdate = true;
    pathLine.visible = true;
  }

  function updateEffects(t) {
    let i = 0;
    const keep = [];
    for (const p of particles) {
      const k = (t - p.t0) / p.dur;
      if (k >= 1) { if (p.onArrive) p.onArrive(); continue; }
      keep.push(p);
      for (let j = 0; j < p.trail && i < MAX_PARTICLES; j++) {
        const kk = k - j * 0.045;
        if (kk < 0) break;
        p.curve.getPoint(ease.inOut(kk), dummy.position);
        dummy.scale.setScalar(p.size * (1 - j * 0.24));
        dummy.updateMatrix();
        pMesh.setMatrixAt(i, dummy.matrix);
        tmpColor.copy(p.color).multiplyScalar(1 - j * 0.25);
        pMesh.setColorAt(i, tmpColor);
        i++;
      }
    }
    particles = keep;
    pMesh.count = i;
    pMesh.instanceMatrix.needsUpdate = true;
    if (pMesh.instanceColor) pMesh.instanceColor.needsUpdate = true;
    for (const b of beams) {
      if (!b.line.visible) continue;
      const k = (t - b.t0) / b.dur;
      if (k >= 1) { b.line.visible = false; continue; }
      b.line.material.opacity = (1 - k) * 0.85;
    }
    for (const p of pops) {
      if (!p.m.visible) continue;
      const k = (t - p.t0) / 520;
      if (k >= 1) { p.m.visible = false; continue; }
      p.m.scale.setScalar(1 + ease.out(k) * 0.9);
      p.m.position.y += 0.01;
      p.m.material.opacity = 1 - k;
    }
    if (disk) {
      const k = clamp(1 - (t - disk.pulse) / 300, 0, 1);
      disk.halo.material.color.copy(disk.pulseColor);
      disk.halo.material.opacity = 0.12 + k * 0.6;
      disk.rings.forEach((r, i) => {
        r.rotation.z += 0.004 * (i + 1) * (1 + k * 6);
        r.material.color.copy(col(C.violet)).lerp(disk.pulseColor, k).multiplyScalar(0.9 + k * 1.8);
      });
      disk.head.rotation.y = Math.sin(t / 900) * 0.35 + k * 0.2;
    }
    dust.rotation.y += 0.0002;
  }

  /* ---------- camera ---------- */

  const insets = { left: 0, right: 0, top: 0, bottom: 0 };
  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    camera.aspect = w / h;
    const sx = (insets.left - insets.right) / 2;
    const sy = (insets.top - insets.bottom) / 2;
    camera.setViewOffset(w, h, -sx, -sy, w, h);
    camera.updateProjectionMatrix();
  }

  function preset(name) {
    const s = Math.max(L.poolW, 8);
    const planTop = plan ? plan.client.position.y + 2 : 10;
    const planY = planTop / 2;
    const half = Math.tan((camera.fov * Math.PI) / 360);
    const planD = Math.max((planTop / 2) / half, (L.planW / 2) / (half * Math.max(0.8, camera.aspect * 0.6))) * 1.18 + 2;
    switch (name) {
      case "plan": return { target: [0, planY, L.planZ], pos: [planD * 0.18, planY + 1.5, L.planZ + planD] };
      case "pool": return { target: [0, 0, 0.8], pos: [0.01, s * 1.9, s * 0.62] };
      case "arc": {
        const span = lanes ? lanes.cacheW * 3 + 3 : 20;
        const d = (span / 2) / (Math.tan((camera.fov * Math.PI) / 360) * Math.max(1, camera.aspect * 0.62));
        return { target: [0, 0, L.laneZ + 0.2], pos: [0, d * 0.62, L.laneZ + d * 0.46] };
      }
      case "disk": return { target: [0, DISK_Y + 1, 0], pos: [s * 1.05, DISK_Y - 1.5, s * 1.25] };
      default: {
        const top = plan ? plan.client.position.y + 1.5 : 8;
        const cy = (top + DISK_Y) / 2;
        const cz = (L.planZ + L.laneZ) / 2;
        const radius = Math.max(top - DISK_Y, L.laneZ - L.planZ, L.planW, s * 1.6) * 0.6;
        const dist = radius / Math.sin((camera.fov * Math.PI) / 360);
        const dir = new THREE.Vector3(0.36, 0.4, 0.86).normalize().multiplyScalar(dist);
        return { target: [0, cy + 1, cz], pos: [dir.x, cy + dir.y, cz + dir.z] };
      }
    }
  }

  function fly(name, instant = false) {
    camView = name;
    userMoved = false;
    const p = preset(name);
    const to = { pos: new THREE.Vector3(...p.pos), target: new THREE.Vector3(...p.target) };
    if (instant) {
      camera.position.copy(to.pos);
      controls.target.copy(to.target);
      tween = null;
      return;
    }
    tween = { t0: performance.now(), from: { pos: camera.position.clone(), target: controls.target.clone() }, to };
  }

  function updateCamera(t) {
    if (!tween) return;
    const k = clamp((t - tween.t0) / 1100, 0, 1);
    const e = ease.inOut(k);
    camera.position.lerpVectors(tween.from.pos, tween.to.pos, e);
    controls.target.lerpVectors(tween.from.target, tween.to.target, e);
    if (k >= 1) tween = null;
  }
  controls.addEventListener("start", () => { tween = null; userMoved = true; });

  /* ---------- picking ---------- */

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function pickAt(clientX, clientY) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const targets = [];
    for (const tile of tiles) if (tile.group.visible) targets.push(tile.mesh);
    if (plan) for (const nd of plan.nodes.values()) targets.push(nd.slab);
    if (lanes) targets.push(lanes.solid, lanes.ghost);
    if (disk) targets.push(disk.body);
    const hit = ray.intersectObjects(targets, false)[0];
    if (!hit) return null;
    const info = hit.object.userData.pick;
    if (info.type === "lane") {
      const order = hit.object === lanes.solid ? lanes.order.solid : lanes.order.ghost;
      const p = order[hit.instanceId];
      return p == null ? null : { type: "page", p };
    }
    return info;
  }

  let down = null;
  renderer.domElement.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    down = null;
    selected = pickAt(e.clientX, e.clientY);
    onPick(selected);
  });
  let hoverAt = 0;
  renderer.domElement.addEventListener("pointermove", (e) => {
    const t = performance.now();
    if (e.buttons || t - hoverAt < 40) return;
    hoverAt = t;
    hovered = pickAt(e.clientX, e.clientY);
    container.classList.toggle("point", !!hovered);
    onHover(hovered, e.clientX, e.clientY);
  });
  renderer.domElement.addEventListener("pointerleave", () => { hovered = null; onHover(null); });

  /* ---------- public surface ---------- */

  window.addEventListener("resize", resize);
  container.classList.add("grab");

  return {
    setFrames(n) {
      if (n !== L.frames) { buildPool(n); fly("overview", true); }
    },
    setPlan,
    effect,
    clearEffects,
    setInsets(v) {
      if (v.left === insets.left && v.right === insets.right && v.top === insets.top && v.bottom === insets.bottom) return;
      Object.assign(insets, v);
      resize();
    },
    fly,
    setAutoRotate(on) { autoRotate = on; controls.autoRotate = on; },
    get autoRotate() { return autoRotate; },
    select(sel) { selected = sel; },
    update(t, dt, model, stats) {
      if (model) {
        updateTiles(model, t);
        updateLanes(model, dt);
        updatePath(updatePlan(t, stats, model), model);
      }
      updateEffects(t);
      updateCamera(t);
      controls.update(dt);
      composer.render(dt);
    },
    redrawCards() { if (plan) for (const nd of plan.nodes.values()) nd.key = ""; for (const tile of tiles) tile.key = ""; },
    resize,
  };
}
