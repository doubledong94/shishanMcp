import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createTweenEngine, sineInOut } from "./anim.js";

const app = document.getElementById("app");
const projectSel = document.getElementById("project");
const viewSel = document.getElementById("view");
const loadBtn = document.getElementById("view-btn");
const statsEl = document.getElementById("stats");
const errorEl = document.getElementById("error");
const resultBox = document.getElementById("result-box");
const resultRowsEl = document.getElementById("result-rows");
const selEl = document.getElementById("sel");
const dirSel = document.getElementById("dir");
const expandBtn = document.getElementById("expand-btn");
const resetBtn = document.getElementById("reset-btn");
const modeBtn = document.getElementById("mode-btn");
const layoutBtn = document.getElementById("layout-btn");

// ===================== 3D 图谱可视化（对齐旧项目 shishandaimaViewer） =====================
const tween = createTweenEngine();

let scene, camera, renderer, controls; // controls = OrbitControls（仅 3D 模式使用）
let graphGroup;
let nodeSprites = new Map(); // id -> { sprite, label, base }
let nodesById = new Map(); // id -> node
let nodePos = new Map(); // id -> THREE.Vector3
let edgeMesh = null; // InstancedMesh（相机朝向带状边 + 流光）
let edgeData = []; // {from,to} 与实例索引对齐
let edgeFlow = new Float32Array(0); // 每实例 flow（-2 表示无流光）
let state = { nodes: [], edges: [] };
let selectedId = null;
let hoverId = null;
let highlightIds = new Set(); // 定位 Neo4j 节点时的命中高亮
let groupIds = new Set(); // 组合键/维度选择的范围高亮

let layoutMode = "2d"; // 2d（默认，平移/缩放/绕Z）| 3d（轨道）
let layoutRunning = true;
let viewTarget = new THREE.Vector3(0, 0, 0); // 2D 视角中心
let viewDist = 60; // 2D 相机距离
let viewRotZ = 0; // 2D 绕 Z 旋转
let lastTime = performance.now();
let densityTick = 0;

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const _dummy = new THREE.Object3D();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _c = new THREE.Color();

// ---------- 节点配色：保留按 kind 的类型彩虹配色 ----------
const KIND_COLORS = {
  Class: 0x7ee787,
  Method: 0xd2a8ff,
  Field: 0x79c0ff,
  Value: 0xffa657,
  CalledMethod: 0xe3b341,
  Condition: 0xff7b72,
  Symbol: 0x238636,
  File: 0x58a6ff,
  Project: 0xe3b341,
  Result: 0xff7b72,
};
const DEF_COLOR = 0x8b949e;

function kindColor(kind) {
  return KIND_COLORS[kind] ?? DEF_COLOR;
}

// 圆形贴片纹理（billboard 扁平圆形，中间实、边缘羽化到透明）
const DISC_TEX = (() => {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.65, "rgba(255,255,255,0.9)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();

function makeNodeSprite(id) {
  const mat = new THREE.SpriteMaterial({
    map: DISC_TEX,
    transparent: true,
    depthWrite: false,
    color: kindColor(nodesById.get(id).kind),
  });
  const sprite = new THREE.Sprite(mat);
  sprite.userData.nodeId = id;
  sprite.scale.set(2, 2, 1);
  return sprite;
}

/** 标签只显示在选中/悬停节点上 */
function makeLabel(text) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.font = "26px system-ui, sans-serif";
  ctx.fillStyle = "#e6edf3";
  ctx.textBaseline = "middle";
  ctx.fillText(text.length > 22 ? text.slice(0, 22) + "…" : text, 8, 32);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(5, 1.6, 1);
  return sprite;
}

// ---------- 边：相机朝向扁平带状 + 流光（移植旧 FlowLine） ----------
// 每个实例是一张 1x1 平面，每帧按两端点+朝向相机定位；uv.x 沿边方向（供流光），uv.y 横跨宽度。
const EDGE_VERT = `
attribute float aFlow;
varying float vUvx;
varying float vUvy;
void main() {
  vUvx = uv.x;
  vUvy = uv.y;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;
const EDGE_FRAG = `
#ifdef USE_INSTANCING_COLOR
varying float vUvx;
varying float vUvy;
void main() {
  vec3 c = instanceColor;
  // 方向明暗：uv.y 大于中线一侧微亮，模拟 FlatLine 的方向暗示
  float shade = (vUvy > 0.5) ? 1.16 : 0.9;
  vec3 outC = c * shade;
  // 流光：aFlow 在 [0,1] 时画一段移动亮带
  float flow = aFlow;
  if (flow >= 0.0 && flow <= 1.0) {
    float band = 0.95 * smoothstep(0.16, 0.0, abs(vUvx - flow));
    outC += band * vec3(1.0, 1.0, 0.92);
  }
  gl_FragColor = vec4(outC, 0.55);
}
#endif`;

function rebuildEdges() {
  const edges = state.edges.filter((e) => nodePos.has(e.from) && nodePos.has(e.to));
  edgeData = edges.map((e) => ({ from: e.from, to: e.to }));
  if (edgeMesh) {
    graphGroup.remove(edgeMesh);
    edgeMesh.geometry.dispose();
    edgeMesh.material.dispose();
    edgeMesh = null;
  }
  const count = edgeData.length;
  if (count === 0) return;
  const geo = new THREE.PlaneGeometry(1, 1);
  edgeFlow = new Float32Array(count).fill(-2);
  geo.setAttribute("aFlow", new THREE.InstancedBufferAttribute(edgeFlow, 1));
  const mat = new THREE.ShaderMaterial({
    vertexShader: EDGE_VERT,
    fragmentShader: EDGE_FRAG,
    transparent: true,
    depthWrite: false,
  });
  edgeMesh = new THREE.InstancedMesh(geo, mat, count);
  const color = new THREE.Color();
  edgeData.forEach((e, i) => {
    const src = nodesById.get(e.from);
    color.setHex(kindColor(src ? src.kind : DEF_COLOR));
    edgeMesh.setColorAt(i, color);
  });
  graphGroup.add(edgeMesh);
}

function updateEdgeMatrices() {
  if (!edgeMesh) return;
  const camPos = camera.position;
  for (let i = 0; i < edgeData.length; i++) {
    const e = edgeData[i];
    const a = nodePos.get(e.from);
    const b = nodePos.get(e.to);
    if (!a || !b) {
      _dummy.position.set(0, 0, 0);
      _dummy.scale.setScalar(0);
      _dummy.updateMatrix();
      edgeMesh.setMatrixAt(i, _dummy.matrix);
      continue;
    }
    _v1.copy(b).sub(a);
    const len = _v1.length();
    if (len < 1e-6) {
      _dummy.position.set(0, 0, 0);
      _dummy.scale.setScalar(0);
      _dummy.updateMatrix();
      edgeMesh.setMatrixAt(i, _dummy.matrix);
      continue;
    }
    const dir = _v1.divideScalar(len);
    _v2.copy(a).add(b).multiplyScalar(0.5); // 中点
    // 宽度轴 = 垂直(指向相机方向 × 边方向)，使其朝向相机
    _v3.copy(camPos).sub(_v2);
    _v4.copy(_v3).cross(dir);
    if (_v4.lengthSq() < 1e-8) _v4.set(0, 1, 0);
    _v4.normalize();
    const thickness = 1.1;
    _m.makeBasis(dir.clone().multiplyScalar(len), _v4.clone().multiplyScalar(thickness), _v3.clone().cross(dir).normalize());
    _m.setPosition(_v2);
    edgeMesh.setMatrixAt(i, _m);
  }
  edgeMesh.instanceMatrix.needsUpdate = true;
}

// ---------- 布局：连续力导向仿真（移植旧 FR，让节点涌动沉降） ----------
const LAYOUT = { repulsion: 2.5, minDist: 1.2, refTarget: 6, target: 3, spring: 0.02, center: 0.05, temperature: 0.22 };

function stepLayout(dt) {
  const nodes = state.nodes;
  const n = nodes.length;
  if (!n) return;
  const k = Math.min(dt / 16.666, 2) * LAYOUT.temperature;
  // 斥力（所有节点对）
  for (let i = 0; i < n; i++) {
    const a = nodePos.get(nodes[i].id);
    for (let j = i + 1; j < n; j++) {
      const b = nodePos.get(nodes[j].id);
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      let dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < 1e-6) { a.x += (Math.random() - 0.5) * 0.01; dist = 1e-6; }
      const d = Math.max(dist, LAYOUT.minDist);
      const f = (k * LAYOUT.repulsion) / (d * d);
      const fx = (f * dx) / d, fy = (f * dy) / d, fz = (f * dz) / d;
      a.x -= fx; a.y -= fy; a.z -= fz;
      b.x += fx; b.y += fy; b.z += fz;
    }
  }
  // 弹簧（边）
  for (const e of state.edges) {
    const a = nodePos.get(e.from);
    const b = nodePos.get(e.to);
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 1e-6) continue;
    const target = e.label === "REFERENCES" ? LAYOUT.refTarget : LAYOUT.target;
    const fx = ((dist - target) / dist) * dx * k * LAYOUT.spring;
    const fy = ((dist - target) / dist) * dy * k * LAYOUT.spring;
    const fz = ((dist - target) / dist) * dz * k * LAYOUT.spring;
    a.x += fx; a.y += fy; a.z += fz;
    b.x -= fx; b.y -= fy; b.z -= fz;
  }
  // 居中（拉向当前质心，防止整体漂移）
  let cx = 0, cy = 0, cz = 0;
  for (const v of nodePos.values()) { cx += v.x; cy += v.y; cz += v.z; }
  cx /= n; cy /= n; cz /= n;
  for (const v of nodePos.values()) {
    v.x -= cx * k * LAYOUT.center;
    v.y -= cy * k * LAYOUT.center;
    v.z -= cz * k * LAYOUT.center;
  }
  if (layoutMode === "2d") for (const v of nodePos.values()) v.z = 0;
  // 同步对象位置
  for (const [id, v] of nodePos) {
    const ent = nodeSprites.get(id);
    if (ent) ent.sprite.position.copy(v);
  }
}

// ---------- 密度自适应大小（移植 scaleByDistance：密处小、疏处大） ----------
function updateScaleByDistance() {
  const nodes = state.nodes;
  const n = nodes.length;
  if (n < 2) return;
  for (let i = 0; i < n; i++) {
    const a = nodePos.get(nodes[i].id);
    let best = Infinity;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const b = nodePos.get(nodes[j].id);
      const dx = a.x - b.x, dy = a.y - b.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) best = d2;
    }
    const dist = Math.max(Math.sqrt(best), 0.4);
    const node = nodes[i];
    const isRoot = node.kind === "Project" || node.kind === "Result";
    const s = isRoot ? 3.6 : THREE.MathUtils.clamp(2.4 * Math.sqrt(dist * 0.6), 1.0, 3.2);
    const ent = nodeSprites.get(node.id);
    if (ent) ent.sprite.scale.set(s, s, 1);
  }
}

function updateLabelPositions() {
  for (const [id, ent] of nodeSprites) {
    const v = nodePos.get(id);
    if (!v) continue;
    ent.label.position.copy(v).add(_v1.set(0, ent.sprite.scale.y * 0.8, 0));
  }
}

/** 统一应用高亮/透明态：选中|高亮 → 提亮 alpha 1.0；悬停 → 微亮；其余 → 半透明 */
function applyHighlights() {
  for (const [id, ent] of nodeSprites) {
    const on = id === selectedId || id === hoverId || highlightIds.has(id) || groupIds.has(id);
    if (id === selectedId || highlightIds.has(id) || groupIds.has(id)) {
      _c.setHex(ent.base).multiplyScalar(1.28);
      ent.sprite.material.color.copy(_c);
      ent.sprite.material.opacity = 1.0;
    } else if (id === hoverId) {
      _c.setHex(ent.base).multiplyScalar(1.14);
      ent.sprite.material.color.copy(_c);
      ent.sprite.material.opacity = 0.92;
    } else {
      ent.sprite.material.color.setHex(ent.base);
      ent.sprite.material.opacity = 0.35;
    }
    ent.label.visible = on;
  }
}

// ---------- 相机 / 控制器（2D 平移缩放 + 3D 轨道） ----------
function cameraForMode() {
  if (layoutMode === "2d") {
    camera.position.set(viewTarget.x, viewTarget.y, viewDist);
    camera.lookAt(viewTarget.x, viewTarget.y, 0);
    camera.rotateZ(viewRotZ);
  }
}

function centerView() {
  const nodes = state.nodes;
  if (!nodes.length) return;
  let cx = 0, cy = 0, cz = 0, maxR = 0;
  for (const n of nodes) {
    const v = nodePos.get(n.id);
    cx += v.x; cy += v.y; cz += v.z;
  }
  cx /= nodes.length; cy /= nodes.length; cz /= nodes.length;
  for (const n of nodes) {
    const v = nodePos.get(n.id);
    const r = Math.hypot(v.x - cx, v.y - cy, v.z - cz);
    if (r > maxR) maxR = r;
  }
  viewTarget.set(cx, cy, cz);
  viewDist = THREE.MathUtils.clamp(maxR * 3 + 24, 30, 400);
  if (layoutMode === "3d") {
    controls.target.copy(viewTarget);
    camera.position.set(cx + maxR * 1.6 + 8, cy + maxR + 8, cz + maxR * 1.6 + 8);
    controls.update();
  }
}

// ---------- 探针 / 交互 ----------
function pickNode(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const sprites = [];
  nodeSprites.forEach((ent) => sprites.push(ent.sprite));
  const hits = raycaster.intersectObjects(sprites, false);
  const hit = hits.find((h) => h.object.userData && h.object.userData.nodeId);
  return hit ? hit.object.userData.nodeId : null;
}

const drag = { active: false, button: -1, startX: 0, startY: 0, lastX: 0, lastY: 0, moved: false };
// 双击态机：同一节点 500ms 内两次单击 = 双击聚焦（复刻旧项目 DoubleClickStateMachine，
// 避免与「单击切换选中」冲突：第二次单击不再切换，而是选中+聚焦）。
const DBL_TIMEOUT = 500;
let lastClick = { id: null, time: 0 };
const keysHeld = new Set(); // 数字键 5-9（维度选择）
let tooltipEl = null; // 悬停信息浮窗

function isTypingTarget(e) {
  const t = e.target;
  return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
}

function nodeInfoHtml(id) {
  const n = nodesById.get(id);
  if (!n) return "";
  return `kind: ${n.kind || "-"}\nlabel: ${n.label || id}`;
}

function ensureTooltip() {
  if (tooltipEl) return tooltipEl;
  tooltipEl = document.createElement("div");
  tooltipEl.className = "node-tooltip";
  tooltipEl.style.cssText =
    "position:fixed;z-index:40;pointer-events:none;background:rgba(13,17,23,.93);color:#c9d1d9;" +
    "border:1px solid #30363d;border-radius:6px;padding:6px 9px;font:12px/1.5 system-ui,sans-serif;" +
    "white-space:pre;display:none;max-width:320px;overflow:hidden;text-overflow:ellipsis;";
  document.body.appendChild(tooltipEl);
  return tooltipEl;
}
function showTooltipAt(x, y, html) {
  const t = ensureTooltip();
  t.innerHTML = html;
  t.style.display = "block";
  t.style.left = x + 14 + "px";
  t.style.top = y + 14 + "px";
}
function hideTooltip() {
  if (tooltipEl) tooltipEl.style.display = "none";
}

function heldKeyNum() {
  for (let k = 5; k <= 9; k++) if (keysHeld.has(String(k))) return k;
  return 0;
}

/** 选中一个节点的连通分量（Ctrl+单击，等价旧项目 ctrl 选整组）。 */
function selectConnectedComponent(id) {
  const seen = new Set([id]);
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of state.edges) {
      const nb = e.from === cur ? e.to : e.to === cur ? e.from : null;
      if (nb && !seen.has(nb)) { seen.add(nb); stack.push(nb); }
    }
  }
  groupIds = seen;
  selectNode(id);
  applyHighlights();
}

/** 选中若干跳内的邻居（数字键 5..9 + 单击 = 1..5 跳）。 */
function selectNeighbors(id, depth) {
  let frontier = [id];
  const seen = new Set([id]);
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const cur of frontier) {
      for (const e of state.edges) {
        const nb = e.from === cur ? e.to : e.to === cur ? e.from : null;
        if (nb && !seen.has(nb)) { seen.add(nb); next.push(nb); }
      }
    }
    frontier = next;
  }
  groupIds = seen;
  selectNode(id);
  applyHighlights();
}

/** 在代码查看器打开节点对应的源码文件（Shift+单击，尽力而为）。 */
function openNodeSource(id) {
  const n = nodesById.get(id);
  const cand = (n && n.label ? n.label : "").trim();
  if (cand && /\//.test(cand) && !SKIP_FILE_RE.test(cand)) {
    if (codeProjectSel.value) {
      openFile(cand);
      return;
    }
    errorEl.textContent = "未选项目，无法打开源码";
    return;
  }
  errorEl.textContent = `无法从节点「${cand || id}」定位源码文件`;
}

/** 单击/组合键 统一入口：双击态机 + 组合键 + 切换选中。空点 = 无操作（对齐旧项目）。 */
function handleNodeClick(id, e) {
  if (id == null) {
    lastClick.id = null;
    lastClick.time = 0;
    return;
  }
  const now = performance.now();
  if (e.ctrlKey) { lastClick.id = id; lastClick.time = now; selectConnectedComponent(id); return; }
  if (e.shiftKey) { lastClick.id = id; lastClick.time = now; openNodeSource(id); return; }
  const dim = heldKeyNum();
  if (dim) { lastClick.id = id; lastClick.time = now; selectNeighbors(id, dim - 4); return; }
  if (lastClick.id === id && now - lastClick.time <= DBL_TIMEOUT) {
    // 同一节点 500ms 内第二次单击 → 双击聚焦（不切换，保持选中）
    lastClick.id = null;
    lastClick.time = 0;
    selectNode(id);
    focusNode(id);
    return;
  }
  lastClick.id = id;
  lastClick.time = now;
  // 单击：切换选中（已选中再点 → 取消选中）
  if (selectedId === id) selectNode(null);
  else selectNode(id);
}

function setupInteraction() {
  const el = renderer.domElement;

  el.addEventListener("pointerdown", (e) => {
    if (layoutMode === "2d") {
      drag.active = true;
      drag.button = e.button;
      drag.startX = drag.lastX = e.clientX;
      drag.startY = drag.lastY = e.clientY;
      drag.moved = false;
      el.setPointerCapture(e.pointerId);
    }
  });

  el.addEventListener("pointermove", (e) => {
    if (layoutMode === "2d" && drag.active) {
      const dx = e.clientX - drag.lastX;
      const dy = e.clientY - drag.lastY;
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      if (Math.abs(e.clientX - drag.startX) + Math.abs(e.clientY - drag.startY) > 3) drag.moved = true;
      hideTooltip();
      if (drag.button === 0 || drag.button === 2) {
        // 平移（按当前 2D 视角尺度换算到世界）
        const worldPerPx = (2 * viewDist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / renderer.domElement.clientHeight;
        viewTarget.x -= (dx * Math.cos(viewRotZ) + dy * Math.sin(viewRotZ)) * worldPerPx;
        viewTarget.y -= (-dx * Math.sin(viewRotZ) + dy * Math.cos(viewRotZ)) * worldPerPx;
        if (layoutMode === "2d") viewTarget.z = 0;
      } else if (drag.button === 1) {
        viewRotZ += dx * 0.005;
      }
      return;
    }
    // 悬停拾取 + 高亮 + tooltip
    const id = pickNode(e.clientX, e.clientY);
    if (id !== hoverId) {
      hoverId = id;
      applyHighlights();
    }
    if (id) showTooltipAt(e.clientX, e.clientY, nodeInfoHtml(id));
    else hideTooltip();
  });

  const endDrag = (e) => {
    if (layoutMode !== "2d" || !drag.active) return;
    drag.active = false;
    if (!drag.moved && e.button === 0) {
      const id = pickNode(e.clientX, e.clientY);
      handleNodeClick(id, e); // 切换选中 / 双击聚焦 / 组合键；空点无操作
    }
  };
  el.addEventListener("pointerup", endDrag);
  el.addEventListener("pointercancel", endDrag);

  // 缩放（2D）
  el.addEventListener("wheel", (e) => {
    if (layoutMode !== "2d") return;
    e.preventDefault();
    viewDist *= 1 + e.deltaY * 0.0012;
    viewDist = THREE.MathUtils.clamp(viewDist, 5, 2000);
  }, { passive: false });

  // 右键流光级联（shift+右键 = 反向流光，同旧项目）
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const id = pickNode(e.clientX, e.clientY);
    if (id) startFlowFrom(id, e.shiftKey);
  });

  // 数字键 5-9（+单击 = 按跳数选邻居）
  window.addEventListener("keydown", (e) => {
    if (isTypingTarget(e)) return;
    if (/^[5-9]$/.test(e.key)) keysHeld.add(e.key);
  });
  window.addEventListener("keyup", (e) => keysHeld.delete(e.key));
  window.addEventListener("blur", () => keysHeld.clear());
}

/** 相机平滑聚焦到节点：正弦缓动平移（2D 移视角中心，3D 平移相机+target，保持距离/朝向）。 */
function focusNode(id) {
  const p = nodePos.get(id);
  if (!p) return;
  if (layoutMode === "2d") {
    const fx = viewTarget.x, fy = viewTarget.y;
    tween.add({
      from: 0, to: 1, duration: 500, ease: sineInOut,
      onUpdate: (t) => {
        viewTarget.x = fx + (p.x - fx) * t;
        viewTarget.y = fy + (p.y - fy) * t;
      },
    });
  } else {
    const from = {
      cx: camera.position.x, cy: camera.position.y, cz: camera.position.z,
      tx: controls.target.x, ty: controls.target.y, tz: controls.target.z,
    };
    // 保持的偏移（方向+距离不变）——用局部变量，避免被共享临时向量覆写
    const off = camera.position.clone().sub(controls.target);
    const endPos = p.clone().add(off);
    tween.add({
      from: 0, to: 1, duration: 500, ease: sineInOut,
      onUpdate: (t) => {
        camera.position.set(
          from.cx + (endPos.x - from.cx) * t,
          from.cy + (endPos.y - from.cy) * t,
          from.cz + (endPos.z - from.cz) * t,
        );
        controls.target.set(
          from.tx + (p.x - from.tx) * t,
          from.ty + (p.y - from.ty) * t,
          from.tz + (p.z - from.tz) * t,
        );
      },
    });
  }
}

/** 边流光脉冲：沿「该节点 → 选中邻居」的边传播，到达端点再级联（穿越选中子图）。 */
function startFlowFrom(id, backward = false) {
  const edges = state.edges;
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    let targetId = null;
    if (e.from === id && nodeSprites.has(e.to)) targetId = e.to;
    else if (e.to === id && nodeSprites.has(e.from)) targetId = e.from;
    if (!targetId || targetId === id) continue;
    // 只有到达端点是「选中/高亮/组选」才继续级联；否则仅让这条边亮一次
    const cascade = targetId === selectedId || highlightIds.has(targetId) || groupIds.has(targetId);
    animateFlowEdge(i, targetId, cascade, backward);
  }
}

function animateFlowEdge(idx, targetId, cascade, backward) {
  // backward = 反向流光（shift+右键）
  const from = backward ? 1 : 0;
  const to = backward ? 0 : 1;
  edgeFlow[idx] = from;
  edgeMesh.instanceMatrix.needsUpdate = true;
  tween.add({
    from, to, duration: 550, ease: sineInOut,
    onUpdate: (v) => {
      edgeFlow[idx] = v;
      edgeMesh.instanceMatrix.needsUpdate = true;
    },
    onEnd: () => {
      edgeFlow[idx] = -2;
      edgeMesh.instanceMatrix.needsUpdate = true;
      if (cascade) startFlowFrom(targetId, backward); // 级联到下一跳
    },
  });
}

// ---------- 场景初始化与主循环 ----------
function initThree() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a0f); // 对齐旧项目 (0.1,0.1,0.12)（无光照 unlit）

  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.001, 100000);
  camera.position.set(0, 0, 60);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  app.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enabled = false; // 默认 2D

  graphGroup = new THREE.Group();
  scene.add(graphGroup);

  setupInteraction();

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  lastTime = performance.now();
  animate();
}

function animate(now) {
  requestAnimationFrame(animate);
  let dt = now - lastTime;
  lastTime = now;
  if (dt > 100) dt = 16;

  tween.update(dt);
  if (layoutRunning && state.nodes.length) stepLayout(dt);
  densityTick++;
  if ((densityTick & 7) === 0) updateScaleByDistance();
  updateLabelPositions();
  applyHighlights();
  updateEdgeMatrices();
  cameraForMode();
  if (layoutMode === "3d") controls.update();
  renderer.render(scene, camera);
}

// ---------- 数据接入（保留原接口） ----------
function clearGraph() {
  while (graphGroup.children.length) graphGroup.remove(graphGroup.children[0]);
  nodeSprites.clear();
  nodesById.clear();
  nodePos.clear();
  edgeMesh = null;
  edgeData = [];
  edgeFlow = new Float32Array(0);
  state = { nodes: [], edges: [] };
  selectedId = null;
  hoverId = null;
  highlightIds = new Set();
  groupIds = new Set();
}

/** 把 data 并入当前图并补齐缺失对象/位置（增量，保留已有节点位置 → 供沉降动画）。 */
function renderGraph(data, seedId) {
  const isFresh = state.nodes.length === 0;
  mergeView(data);
  nodesById.clear();
  for (const n of state.nodes) nodesById.set(n.id, n);

  const seedPos = seedId ? nodePos.get(seedId) : null;
  for (const n of state.nodes) {
    if (nodeSprites.has(n.id)) continue;
    const p = new THREE.Vector3();
    if (seedPos) {
      p.copy(seedPos).add(new THREE.Vector3((Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10, 0));
    } else {
      p.set((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, layoutMode === "2d" ? 0 : (Math.random() - 0.5) * 10);
    }
    nodePos.set(n.id, p);
    const sprite = makeNodeSprite(n.id);
    sprite.position.copy(p);
    const label = makeLabel(n.label);
    label.visible = false;
    graphGroup.add(sprite);
    graphGroup.add(label);
    nodeSprites.set(n.id, { sprite, label, base: kindColor(n.kind) });
  }

  rebuildEdges();
  if (isFresh) centerView(); // 仅在全新加载时居中；增量并入（探索/定位）不跳相机
  statsEl.textContent = `${state.nodes.length} 节点 · ${state.edges.length} 边`;
  errorEl.textContent = "";
  renderResultRows(data.rows);
  applyHighlights();
}

/** 展示非图结构（纯标量）的查询结果行。 */
function renderResultRows(rows) {
  resultBox.hidden = !rows || rows.length === 0;
  if (!rows || rows.length === 0) {
    resultRowsEl.innerHTML = "";
    return;
  }
  resultRowsEl.innerHTML = "";
  for (const line of rows) {
    const row = document.createElement("span");
    row.className = "result-row";
    const m = String(line).match(/^([^:]+): ([\s\S]*)$/);
    if (m) {
      const key = document.createElement("b");
      key.textContent = m[1] + ": ";
      row.append(key);
      row.append(document.createTextNode(m[2]));
    } else {
      row.textContent = line;
    }
    resultRowsEl.appendChild(row);
  }
}

function selectNode(id) {
  selectedId = id;
  expandBtn.disabled = !id;
  selEl.textContent = id ? `已选中: ${(nodesById.get(id) || {}).label || id}` : "未选中节点";
  applyHighlights();
}

async function expand() {
  if (!selectedId) return;
  errorEl.textContent = "";
  const project = projectSel.value;
  const dir = dirSel.value;
  const cypher =
    `MATCH (a {id:$id})-[r:${dir}]-(b {projectId:$project}) ` +
    "RETURN a, r, b LIMIT 200";
  const url =
    `/api/graph/query?project=${encodeURIComponent(project)}` +
    `&cypher=${encodeURIComponent(cypher)}&id=${encodeURIComponent(selectedId)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${res.status}: ${body.slice(0, 200)}`);
    }
    const view = await res.json();
    renderGraph(view, selectedId); // 增量并入，新节点在选中节点附近生成并沉降
  } catch (err) {
    errorEl.textContent = `扩展失败: ${err instanceof Error ? err.message : err}`;
  }
}

/** 把新查询到的节点/边并入当前状态（按 id 去重）。 */
function mergeView(view) {
  const nodes = view.nodes || [];
  const edges = view.edges || [];
  const seenNode = new Set(state.nodes.map((n) => n.id));
  for (const n of nodes) {
    if (!seenNode.has(n.id)) {
      state.nodes.push(n);
      seenNode.add(n.id);
    }
  }
  const seenEdge = new Set(state.edges.map((e) => `${e.from}->${e.to}->${e.label}`));
  for (const e of edges) {
    const key = `${e.from}->${e.to}->${e.label}`;
    if (!seenEdge.has(key)) {
      state.edges.push(e);
      seenEdge.add(key);
    }
  }
}

async function loadProjects() {
  const res = await fetch("/api/projects");
  const data = await res.json();
  projectSel.innerHTML = "";
  for (const p of data.projects || []) {
    const opt = document.createElement("option");
    opt.value = p.name;
    opt.textContent = p.name;
    projectSel.appendChild(opt);
  }
}

async function loadViews() {
  const project = projectSel.value;
  if (!project) return;
  const res = await fetch(`/api/graph/views?project=${encodeURIComponent(project)}`);
  const data = await res.json();
  viewSel.innerHTML = '<option value="">— 读取 query_graph 的 latest 快照 —</option>';
  for (const v of data.views || []) {
    const opt = document.createElement("option");
    opt.value = v.id;
    opt.textContent = `${v.id} · ${v.createdAt || ""}`;
    viewSel.appendChild(opt);
  }
}

async function load() {
  errorEl.textContent = "";
  const project = projectSel.value;
  if (!project) {
    errorEl.textContent = "请先选择项目";
    return;
  }
  let viewId = viewSel.value;
  if (!viewId) {
    // 读最近一个快照（query_graph 每次调用都会存）
    const res = await fetch(`/api/graph/views?project=${encodeURIComponent(project)}`);
    const data = await res.json();
    viewId = data.views?.[0]?.id;
    if (!viewId) {
      errorEl.textContent = "该项目还没有图快照。先让 AI 调用 query_graph，或手动 POST /api/run/query_graph";
      return;
    }
  }
  // 加载新视图 → 重置当前图
  clearGraph();
  const viewRes = await fetch(`/api/graph/views/${encodeURIComponent(project)}/${encodeURIComponent(viewId)}`);
  if (!viewRes.ok) {
    errorEl.textContent = `加载视图失败: ${viewRes.status}`;
    return;
  }
  const data = await viewRes.json();
  renderGraph(data);
}

initThree();

// ---------- 控件 ----------
modeBtn.addEventListener("click", () => {
  layoutMode = layoutMode === "2d" ? "3d" : "2d";
  controls.enabled = layoutMode === "3d";
  modeBtn.textContent = layoutMode === "2d" ? "切到 3D" : "切到 2D";
  if (layoutMode === "3d") {
    controls.target.copy(viewTarget);
    camera.position.set(viewTarget.x, viewTarget.y, viewDist);
    controls.update();
    // 三维展开：给节点加 Z 抖动，让布局离开 XY 平面
    for (const v of nodePos.values()) v.z += (Math.random() - 0.5) * 8;
  } else {
    viewTarget.set(controls.target.x, controls.target.y, 0);
    viewDist = Math.max(camera.position.distanceTo(controls.target), 5);
    for (const v of nodePos.values()) v.z = 0;
  }
  applyHighlights();
});

layoutBtn.addEventListener("click", () => {
  layoutRunning = !layoutRunning;
  layoutBtn.textContent = layoutRunning ? "暂停布局" : "继续布局";
});

// ===================== 代码查看器（右侧可折叠侧边栏） =====================
const codeToggleEl = document.getElementById("code-toggle");
const codePanelEl = document.getElementById("code-panel");
const codeCollapseEl = document.getElementById("code-collapse");
const codeProjectSel = document.getElementById("code-project");
const filterEl = document.getElementById("tree-filter");
const treeEl = document.getElementById("tree");
const codeEl = document.getElementById("code");
const cursorEl = document.getElementById("cursor-info");
const locateBtn = document.getElementById("locate-btn");
const clearLocateBtn = document.getElementById("clear-locate-btn");
const locateResultsEl = document.getElementById("locate-results");

const dirCache = new Map(); // 目录相对路径(无尾斜杠) -> entries[]
const opened = new Set(); // 已展开的目录
let contentPath = null; // 当前打开文件的相对路径
let cursor = null; // { line, col, ident }

const SKIP_FILE_RE = /\.(png|jpe?g|gif|svg|ico|woff2?|ttf|eot|pdf|zip|jar|class|o|so|dylib|dll|exe|lock|woff|map)$/i;
const KEYWORDS = new Set([
  "abstract","as","assert","boolean","break","by","byte","case","catch","char","class","companion",
  "const","continue","data","default","do","double","else","enum","extends","final","finally","float",
  "for","fun","if","implements","import","in","instanceof","int","interface","internal","is","lateinit",
  "let","long","native","new","null","object","open","operator","override","package","private","protected",
  "public","return","sealed","short","static","strictfp","super","suspend","switch","synchronized","this",
  "throw","throws","transient","true","false","try","val","var","vararg","void","volatile","when","while",
]);
const TOKEN_RE = /(\/\/[^\n]*|\/\*.*?\*\/|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d[\w.]*\b|\b[A-Za-z_$][\w$]*\b)/g;

function escHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const LABEL_COLORS = {
  Class: "#7ee787",
  Method: "#d2a8ff",
  Field: "#79c0ff",
  Value: "#ffa657",
  CalledMethod: "#e3b341",
  Condition: "#ff7b72",
  Symbol: "#238636",
  File: "#58a6ff",
  Project: "#e3b341",
  Result: "#ff7b72",
};

/** 目录树文件类型的配色（按扩展名），用于文件名前的小圆点。 */
const EXT_COLORS = {
  ts: "#3178c6", tsx: "#3178c6",
  js: "#e3b341", jsx: "#e3b341", mjs: "#e3b341", cjs: "#e3b341",
  kt: "#a97bff", kts: "#a97bff", java: "#ff7b72",
  py: "#58a6ff", go: "#00add8", rs: "#ffa657",
  c: "#6e7681", h: "#6e7681", cpp: "#8b949e", hpp: "#8b949e", cc: "#8b949e",
  sh: "#3fb950", bash: "#3fb950", zsh: "#3fb950",
  md: "#8b949e", txt: "#8b949e",
  xml: "#e3b341", html: "#ff7b72", css: "#ff9d70", scss: "#ff9d70",
  json: "#79c0ff", yaml: "#e3b341", yml: "#e3b341",
  properties: "#8b949e", gradle: "#ff9d70", proto: "#ffa657", sql: "#79c0ff",
};

function fileColor(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  return EXT_COLORS[ext] || "#6e7681";
}

function highlightLine(line) {
  let out = "";
  let last = 0;
  let m;
  while ((m = TOKEN_RE.exec(line))) {
    out += escHtml(line.slice(last, m.index));
    const tok = m[0];
    let cls = "tok-fn";
    if (tok.startsWith("//") || tok.startsWith("/*") || tok.startsWith("*/")) cls = "tok-com";
    else if (/^["'`]/.test(tok)) cls = "tok-str";
    else if (/^\d/.test(tok)) cls = "tok-num";
    else if (KEYWORDS.has(tok)) cls = "tok-kw";
    else if (/^[A-Z]/.test(tok)) cls = "tok-type";
    else if (tok === "fun" || tok === "fn") cls = "tok-kw";
    out += `<span class="${cls}">${escHtml(tok)}</span>`;
    last = m.index + tok.length;
  }
  out += escHtml(line.slice(last));
  return out || "&nbsp;";
}

function renderCode(file) {
  codeEl.innerHTML = "";
  file.content.split("\n").forEach((line, i) => {
    const row = document.createElement("div");
    row.className = "code-line";
    row.dataset.line = String(i + 1);
    const ln = document.createElement("span");
    ln.className = "ln";
    ln.textContent = String(i + 1);
    const txt = document.createElement("span");
    txt.className = "txt";
    txt.innerHTML = highlightLine(line);
    row.append(ln, txt);
    codeEl.appendChild(row);
  });
}

function normDir(p) {
  return String(p || "").replace(/\/+$/, "");
}

async function fetchEntries(rel) {
  const key = normDir(rel);
  const project = codeProjectSel.value;
  const url = `/api/projects/${encodeURIComponent(project)}/entries?path=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return data.entries || [];
}

function renderTree() {
  const q = (filterEl.value || "").trim().toLowerCase();
  treeEl.innerHTML = "";
  if (!codeProjectSel.value) {
    treeEl.innerHTML = "<div class='tree-empty'>暂无项目</div>";
    return;
  }
  if (q) {
    treeEl.innerHTML = "<div class='tree-empty'>搜索中…</div>";
    searchAndRender(q);
    return;
  }
  treeEl.appendChild(makeDirRow(codeProjectSel.value, "", 0, true));
  if (opened.has("")) renderChildren(treeEl, "", 1);
}

function makeBaseRow(cls, key, depth) {
  const row = document.createElement("div");
  row.className = "trow " + cls;
  if (key != null) row.dataset.path = key;
  row.style.paddingLeft = 8 + (depth || 0) * 14 + "px";
  const chev = document.createElement("span");
  chev.className = "chev";
  const dot = document.createElement("span");
  dot.className = "dot";
  const name = document.createElement("span");
  name.className = "name";
  row.append(chev, dot, name);
  return row;
}

function makeDirRow(name, disPath, depth, root) {
  const key = normDir(disPath);
  const row = makeBaseRow("dir-row" + (root ? " root" : ""), key === "" ? null : key, depth);
  row.querySelector(".chev").textContent = opened.has(key) ? "▾" : "▸";
  row.querySelector(".name").textContent = name;
  row.addEventListener("click", () => toggleDir(key, row));
  return row;
}

function makeFileRow(name, relPath, depth) {
  const row = makeBaseRow("file-row", relPath, depth);
  row.querySelector(".chev").textContent = "";
  const dot = row.querySelector(".dot");
  dot.style.background = fileColor(name);
  dot.style.width = "7px";
  dot.style.height = "7px";
  dot.style.borderRadius = "50%";
  row.querySelector(".name").textContent = name;
  row.addEventListener("click", () => openFile(relPath, row));
  return row;
}

function renderChildren(parentEl, relKey, depth) {
  for (const e of dirCache.get(relKey) || []) {
    if (e.type === "dir") {
      parentEl.appendChild(makeDirRow(e.name, e.path, depth));
      const key = normDir(e.path);
      if (opened.has(key)) renderChildren(parentEl, key, depth + 1);
    } else {
      parentEl.appendChild(makeFileRow(e.name, e.path, depth));
    }
  }
}

async function toggleDir(key) {
  if (opened.has(key)) {
    opened.delete(key);
    renderTree();
    return;
  }
  if (!dirCache.has(key)) dirCache.set(key, await fetchEntries(key));
  opened.add(key);
  renderTree();
}

async function searchAndRender(q) {
  const out = [];
  const queue = [""];
  let visited = 0;
  const seen = new Set();
  while (queue.length && visited++ < 2500) {
    const d = queue.shift();
    if (seen.has(d)) continue;
    seen.add(d);
    if (!dirCache.has(d)) dirCache.set(d, await fetchEntries(d));
    const entries = dirCache.get(d);
    for (const e of entries || []) {
      const hit = e.name.toLowerCase().includes(q) || e.path.toLowerCase().includes(q);
      if (e.type === "dir") {
        queue.push(normDir(e.path));
        if (hit) out.push(e);
      } else if (hit && !SKIP_FILE_RE.test(e.name)) {
        out.push(e);
      }
    }
  }
  treeEl.innerHTML = "";
  if (out.length === 0) {
    treeEl.innerHTML = "<div class='tree-empty'>无匹配</div>";
    return;
  }
  for (const e of out.slice(0, 200)) {
    treeEl.appendChild(
      e.type === "dir" ? makeDirRow(e.name, e.path, 0) : makeFileRow(e.name, e.path, 0),
    );
  }
}

async function openFile(relPath, row) {
  if (SKIP_FILE_RE.test(relPath)) return;
  treeEl.querySelectorAll(".file-row.selected").forEach((r) => r.classList.remove("selected"));
  if (row) row.classList.add("selected");
  const project = codeProjectSel.value;
  const url = `/api/projects/${encodeURIComponent(project)}/file?path=${encodeURIComponent(relPath)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      codeEl.innerHTML = `<div class='tree-empty'>加载失败（${res.status}）</div>`;
      return;
    }
    const file = await res.json();
    contentPath = relPath;
    cursor = null;
    highlightIds.clear();
    clearLocateBtn.disabled = true;
    locateResultsEl.hidden = true;
    locateResultsEl.innerHTML = "";
    renderCode(file);
    updateCursorInfo(null);
  } catch (err) {
    codeEl.innerHTML = `<div class='tree-empty'>加载失败: ${err.message || err}</div>`;
  }
}

function resetCodeTree() {
  dirCache.clear();
  opened.clear();
  contentPath = null;
  cursor = null;
  highlightIds.clear();
  clearLocateBtn.disabled = true;
  locateResultsEl.hidden = true;
  locateResultsEl.innerHTML = "";
  codeEl.innerHTML = "<div class='tree-empty'>选择一个文件查看代码</div>";
  updateCursorInfo(null);
  const proj = codeProjectSel.value;
  if (proj) {
    fetchEntries("").then((entries) => {
      dirCache.set("", entries);
      opened.add("");
      renderTree();
    });
  } else {
    renderTree();
  }
}

// ---------- 光标符号检测 ----------

function caretFromPoint(x, y) {
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos) return { node: pos.offsetNode, offset: pos.offset };
  }
  if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(x, y);
    if (range) return { node: range.startContainer, offset: range.startOffset };
  }
  return null;
}

/** 把点击到的词法碎片偏移换算成整个行文本内的偏移。 */
function offsetInLine(txtEl, startNode, offsetInNode) {
  if (!txtEl) return 0;
  const walker = document.createTreeWalker(txtEl, NodeFilter.SHOW_TEXT, null, false);
  let total = 0;
  let node;
  while ((node = walker.nextNode())) {
    if (node === startNode) return total + Math.min(offsetInNode, node.data.length);
    total += node.data.length;
  }
  return total;
}

function wordAt(text, offset) {
  const re = /[A-Za-z_$][\w$]*/g;
  let m;
  while ((m = re.exec(text))) {
    if (offset >= m.index && offset <= m.index + m[0].length) {
      return { start: m.index, end: m.index + m[0].length };
    }
  }
  return { start: Math.min(offset, text.length), end: Math.min(offset, text.length) };
}

function updateCursorInfo(c) {
  cursor = c;
  codeEl.querySelectorAll(".code-line.actCursor").forEach((l) => l.classList.remove("actCursor"));
  if (!c || !c.line) {
    cursorEl.innerHTML = "点击代码定位光标符号";
    locateBtn.disabled = true;
    return;
  }
  if (c.line > 0) {
    const row = codeEl.querySelector(`.code-line[data-line="${c.line}"]`);
    if (row) row.classList.add("actCursor");
  }
  if (!c.ident) {
    cursorEl.innerHTML = `第 ${c.line} 行 ${c.col} 列 · 光标不在符号上`;
    locateBtn.disabled = true;
  } else {
    cursorEl.innerHTML = `第 ${c.line} 行 ${c.col} 列 · <b>${c.ident}</b>`;
    locateBtn.disabled = false;
  }
}

function applyCursorFromPointerup(e) {
  const caret = caretFromPoint(e.clientX, e.clientY);
  if (!caret) return;
  const lineEl =
    caret.node.nodeType === 3
      ? caret.node.parentElement?.closest(".code-line")
      : caret.node?.closest?.(".code-line");
  if (!lineEl) return;
  const txtEl = lineEl.querySelector(".txt");
  if (!txtEl || !txtEl.contains(caret.node)) return;
  let offset = caret.offset;
  if (caret.node.nodeType === 3) offset = offsetInLine(txtEl, caret.node, caret.offset);
  const text = txtEl.textContent;
  const { start, end } = wordAt(text, offset);
  const line = Number(lineEl.dataset.line);
  updateCursorInfo({
    line,
    col: offset + 1,
    ident: end > start ? text.slice(start, end) : null,
  });
}

// ---------- 定位 Neo4j 节点 ----------

function renderLocateMatches(matches, inView) {
  locateResultsEl.innerHTML = "";
  const header = document.createElement("div");
  header.className = "locate-header";
  header.textContent = `命中 ${matches.length} 个节点（点击行定位到 3D 图）`;
  locateResultsEl.appendChild(header);
  if (matches.length === 0) {
    const empty = document.createElement("div");
    empty.className = "locate-empty";
    empty.textContent = "没有找到对应节点：确认该项目已用 --scip-java fork 生成过索引。";
    locateResultsEl.appendChild(empty);
  }
  for (const m of matches) {
    const row = document.createElement("div");
    row.className = "locate-row" + (inView.has(m.id) ? " in-graph" : "");
    const badge = document.createElement("span");
    badge.className = "locate-badge";
    badge.style.background = LABEL_COLORS[m.label] || "#8b949e";
    badge.textContent = m.label;
    const name = document.createElement("span");
    name.className = "locate-name";
    name.textContent = m.name || m.kind || m.id;
    const meta = document.createElement("span");
    meta.className = "locate-meta";
    const parts = [];
    if (m.kind) parts.push(m.kind);
    if (m.line) parts.push(`行 ${m.line}`);
    if (m.signature) parts.push(m.signature);
    meta.textContent = parts.join(" · ");
    row.append(badge, name, meta);
    row.title = `${m.label} · ${m.name || ""}\n${m.signature || ""}\n${m.file}#${m.line}\nsymbol: ${m.symbol || ""}`;
    row.addEventListener("click", () => selectNode(m.id));
    locateResultsEl.appendChild(row);
  }
}

function highlightFoundLines(matches) {
  const lines = new Set(matches.map((m) => m.line));
  codeEl.querySelectorAll(".code-line").forEach((row) => {
    const n = Number(row.dataset.line);
    row.classList.toggle("found", lines.has(n));
  });
}

async function locate() {
  if (!cursor || !cursor.ident || !contentPath) return;
  const project = codeProjectSel.value;
  const qs = new URLSearchParams({
    project,
    file: contentPath,
    line: String(cursor.line),
    col: String(cursor.col),
    name: cursor.ident,
  });
  locateBtn.disabled = true;
  locateBtn.textContent = "定位中…";
  locateResultsEl.hidden = false;
  try {
    const res = await fetch(`/api/graph/symbol?${qs}`);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${res.status}: ${body.slice(0, 160)}`);
    }
    const data = await res.json();
    renderGraph(data.view); // 增量并入，命中节点高亮
    highlightIds = new Set(data.matches.map((m) => m.id));
    applyHighlights();
    const inView = new Set(state.nodes.map((n) => n.id));
    renderLocateMatches(data.matches, inView);
    highlightFoundLines(data.matches);
    clearLocateBtn.disabled = false;
    if (data.matches.length > 0) {
      selectNode(data.matches[0].id);
    }
  } catch (err) {
    locateResultsEl.innerHTML = `<div class='locate-empty'>定位失败: ${err instanceof Error ? err.message : err}</div>`;
  } finally {
    locateBtn.disabled = false;
    locateBtn.textContent = "定位 Neo4j 节点";
  }
}

function clearLocate() {
  highlightIds.clear();
  applyHighlights();
  codeEl.querySelectorAll(".code-line.found").forEach((l) => l.classList.remove("found"));
  clearLocateBtn.disabled = true;
  locateResultsEl.hidden = true;
  locateResultsEl.innerHTML = "";
}

// ---------- 侧边栏折叠 ----------
function setCodePanel(open) {
  codePanelEl.classList.toggle("closed", !open);
  codeToggleEl.style.display = open ? "none" : "block";
}
codeToggleEl.addEventListener("click", () => setCodePanel(true));
codeCollapseEl.addEventListener("click", () => setCodePanel(false));
codeEl.addEventListener("pointerup", applyCursorFromPointerup);
filterEl.addEventListener("input", renderTree);
locateBtn.addEventListener("click", locate);
clearLocateBtn.addEventListener("click", clearLocate);

// ---------- 启动与联动 ----------
function syncScipSelector(name) {
  codeProjectSel.value = name;
}

loadProjects().then(() => {
  // 把项目也填进代码查看器的选择器
  const opts = [...projectSel.options].map((o) => o.value);
  codeProjectSel.innerHTML = "";
  for (const p of opts) {
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = p;
    codeProjectSel.appendChild(opt);
  }
  if (codeProjectSel.value) resetCodeTree();
  loadViews();
  // 从 query_graph 返回的 URL（http://localhost:18081/#/view/<project>/<viewId>）直达对应视图
  const m = location.hash.match(/^#\/view\/([^/]+)\/([^/]+)$/);
  if (m) {
    projectSel.value = decodeURIComponent(m[1]);
    codeProjectSel.value = decodeURIComponent(m[1]);
    loadViews();
    viewSel.value = decodeURIComponent(m[2]);
    load();
    resetCodeTree();
  }
});
projectSel.addEventListener("change", () => {
  syncScipSelector(projectSel.value);
  loadViews();
  resetCodeTree();
});
codeProjectSel.addEventListener("change", () => {
  projectSel.value = codeProjectSel.value;
  loadViews();
  resetCodeTree();
});
loadBtn.addEventListener("click", load);
expandBtn.addEventListener("click", expand);
resetBtn.addEventListener("click", () => {
  selectedId = null;
  load();
});
