import * as THREE from "three";
import { ThreeDControls } from "./ThreeDControls.js"; // 忠实移植旧项目自定义三维相机控制
import { createTweenEngine, sineInOut } from "./anim.js";

// 构建时间：由 vite.config 在构建时注入，随每次构建自动更新（不再手写固定值）
// __BUILD_TIME__ 是构建时刻的纪元毫秒（vite define 注入）；在浏览器里用本地时区格式化成人类可读时间
const BUILD = (() => {
  try {
    const ms = Number(__BUILD_TIME__);
    if (!Number.isFinite(ms)) return "dev";
    return new Date(ms).toLocaleString("zh-CN", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
  } catch {
    return "dev";
  }
})();
const app = document.getElementById("app");
const projectSel = document.getElementById("project");
const viewSel = document.getElementById("view");
const loadBtn = document.getElementById("view-btn");
const statsEl = document.getElementById("stats");
const errorEl = document.getElementById("error");
const resultBox = document.getElementById("result-box");
const resultRowsEl = document.getElementById("result-rows");
const historyHeadEl = document.getElementById("history-head");
const historyCaretEl = document.getElementById("history-caret");
const historyCountEl = document.getElementById("history-count");
const historyRowsEl = document.getElementById("history-rows");
const selEl = document.getElementById("sel");
const dirSel = document.getElementById("dir");
const expandBtn = document.getElementById("expand-btn");
const resetBtn = document.getElementById("reset-btn");
const modeBtn = document.getElementById("mode-btn");
const layoutBtn = document.getElementById("layout-btn");
const zoomEl = document.getElementById("zoom");

// ===================== 3D 图谱可视化（对齐旧项目 shishandaimaViewer） =====================
const tween = createTweenEngine();

let scene, camera, renderer, controls; // controls = OrbitControls（仅 3D 模式使用）
let graphGroup;
let nodeMesh = null; // InstancedMesh（每实例一个实心圆盘，每实例颜色区分选中/悬停）
let instNode = []; // 实例索引 -> node id
let nodeIx = new Map(); // node id -> 实例索引
let nodeScale = new Map(); // node id -> 半径倍率
let nodeLabels = new Map(); // node id -> Sprite（仅选中/悬停显示）
let nodesById = new Map(); // id -> node
let nodePos = new Map(); // id -> THREE.Vector3
let edgeMesh = null; // InstancedMesh（相机朝向带状边 + 流光）
let edgeData = []; // {from,to}，与边缓冲索引对齐
let state = { nodes: [], edges: [] };
let selectedIds = new Set(); // 多选集合（对齐旧项目 nodesObj->selected）
let hoverId = null;
let highlightIds = new Set(); // 定位 Neo4j 节点时的命中高亮
let activeId = null; // 扩展/聚焦用的主选中（最近被选中/点中的）

let layoutMode = "2d"; // 2d（默认，平移/缩放/绕Z）| 3d（轨道）
let layoutRunning = true;
let viewTarget = new THREE.Vector3(0, 0, 0); // 2D 视角中心
let viewHeight = 800; // 2D 正交视图高度（世界单位，越小=放大）
let viewRotZ = 0; // 2D 绕 Z 旋转
let perspCamera = null; // 3D 透视相机
let orthoCamera = null; // 2D 正交相机
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

// 节点 = 灰色圆盘 + 盘内纹样（对齐旧项目 Nodes）：
// - 未选中灰 (0.5,0.5,0.5) alpha 0.3，选中亮灰 (0.9,0.9,0.9) alpha 1.0，悬停 color/alpha 各 +0.2
// - 圆盘半径 0.7（length(uv)>0.7 → alpha 0），类型用盘内同环/网格纹样区分（非颜色）
// 纹样直接烘焙进灰度贴图（白 = 原盘色，暗带 = 纹样下压 0.3），再用材质 color 乘上当前灰值。
/** 生成节点贴图：把「灰阶亮度 gray + 透明度 texAlpha + 盘内纹样」直接烘焙进贴图，
 *  不依赖 material.color/opacity uniform（有浏览器不应用这两个 uniform，导致节点恒亮）。 */
function makeGlyphTexture(style, gray, texAlpha) {
  const S = 128;
  const cv = document.createElement("canvas");
  cv.width = cv.height = S;
  const ctx = cv.getContext("2d");
  const img = ctx.createImageData(S, S);
  const half = S / 2;
  const band = (l) => (l > 0.6 || (l > 0.5 && l < 0.57) || (l > 0.3 && l < 0.37) || (l < 0.13)) ? 1 : 0;
  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const u = (px + 0.5) / half - 1;
      const v = -((py + 0.5) / half - 1);
      const l = Math.hypot(u, v);
      let a = 0;
      if (l > 0.7) a = 0;
      else if (l > 0.68) a = (0.7 - l) / 0.02;
      else a = 1;
      let darken = 0;
      if (a > 0) {
        const lineX = () => { const x = Math.abs(u); return x > 0.55 || (x > 0.45 && x < 0.52) || (x > 0.25 && x < 0.32) || (x > 0.05 && x < 0.12); };
        const lineY = () => { const y = Math.abs(v); return y > 0.55 || (y > 0.45 && y < 0.52) || (y > 0.25 && y < 0.32) || (y > 0.05 && y < 0.12); };
        switch (style) {
          case 1: if (l > 0.6) { } else if (l > 0.52) darken = 1; break; // 单环
          case 3: darken = band(l); break; // 多环（三圈同心）
          case 6: if (l > 0.6) darken = -1; break; // 外圈提亮
          case 8: if (l > 0.45 && l < 0.65) darken = 1; break; // 中环带（字段/匿名）
          case 2: if (lineX() || lineY()) darken = 1; break; // 十字网格（方法/条件）
          case 5: if (lineX() && lineY()) darken = 1; break; // 细格点（参数/返回）
          default: darken = 0;
        }
      }
      const idx = (py * S + px) * 4;
      const c = 255 * gray * (darken < 0 ? 1.3 : 1 - darken * 0.3);
      img.data[idx] = img.data[idx + 1] = img.data[idx + 2] = Math.round(Math.max(0, Math.min(255, c)));
      img.data[idx + 3] = Math.round(a * texAlpha * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(cv);
}
const GLYPH_TEX = new Map();
function glyphTex(style, gray, texAlpha) {
  const key = `${style}:${gray.toFixed(3)}:${texAlpha.toFixed(2)}`;
  if (!GLYPH_TEX.has(key)) GLYPH_TEX.set(key, makeGlyphTexture(style, gray, texAlpha));
  return GLYPH_TEX.get(key);
}
/** 节点 kind → 盘内纹样（松散映射旧项目 styled1..styled8 语义） */
function styleForKind(kind) {
  switch (kind) {
    case "Symbol": return 3; // scip 引用 → 多环
    case "Method": case "Condition": return 2; // 方法/条件 → 十字网格
    case "CalledMethod": return 1; // 调用 → 单环
    case "Value": return 5; // 参数/返回 → 细格
    case "Field": return 8; // 字段 → 中环带
    case "Class": return 6; // 类 → 外圈提亮
    default: return 0; // File/Project/Result 等 → 平板
  }
}

/** 明暗/透明度相关常量：烘焙进贴图，绕开 color/opacity uniform */
const NODE_STYLE = {
  UNSEL: { gray: 0.38, alpha: 0.22 },
  HOVER: { gray: 0.55, alpha: 0.5 },
  SEL:   { gray: 0.95, alpha: 1.0 },
  SELHOV:{ gray: 1.0,  alpha: 1.0 },
};

// ---- 节点 ShaderMaterial：对齐旧 Nodes.cpp 的两态 alpha ----
// 选中/悬停位编码进 instanceColor 低位（r+=0.002 选中，g+=0.002 悬停），顶点解码后由
// 片段选 alpha：选中 1.0（不透明），未选中 0.3（半透明），悬停 alpha+0.2。
// instanceMatrix / instanceColor 由 three 对 InstancedMesh 的 ShaderMaterial 自动声明注入。
const NODE_VERT = `
varying vec3 vColor;
varying float vSel;
varying float vHov;
void main() {
  float pr = fract(fract(instanceColor.r) * 100.0);
  vSel = (pr > 0.1 && pr < 0.3) ? 1.0 : 0.0;
  float pg = fract(fract(instanceColor.g) * 100.0);
  vHov = (pg > 0.1 && pg < 0.3) ? 1.0 : 0.0;
  vColor = instanceColor;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;
const NODE_FRAG = `
varying vec3 vColor;
varying float vSel;
varying float vHov;
void main() {
  vec3 color = vColor;
  float alpha = vSel > 0.5 ? 1.0 : 0.3;
  if (vHov > 0.5) alpha += 0.2; // 悬停 alpha +0.2（对齐旧 Nodes）
  gl_FragColor = vec4(color, min(alpha, 1.0));
}`;

/** 重新构建节点 InstancedMesh（圆盘 + 每实例颜色与两态 alpha，对齐旧 Nodes.cpp） */
function rebuildNodes() {
  const ids = state.nodes.map((n) => n.id);
  if (nodeMesh) { graphGroup.remove(nodeMesh); nodeMesh.geometry.dispose(); nodeMesh.material.dispose(); nodeMesh = null; }
  nodeLabels.forEach((l) => graphGroup.remove(l));
  nodeLabels.clear();
  instNode = ids;
  nodeIx.clear();
  ids.forEach((id, i) => nodeIx.set(id, i));
  if (ids.length === 0) return;
  const geo = new THREE.CircleGeometry(1, 24);
  // 对齐旧项目：节点 ShaderMaterial 支持 per-instance alpha（选中 1.0 / 未选中 0.3）。
  // transparent+depthTest=false，与边同处透明 pass，靠 renderOrder（节点=1 > 边=0）后画盖住边。
  const mat = new THREE.ShaderMaterial({ vertexShader: NODE_VERT, fragmentShader: NODE_FRAG, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide, uniforms: {} });
  nodeMesh = new THREE.InstancedMesh(geo, mat, ids.length);
  nodeMesh.frustumCulled = false; // 节点实时移动，避免基于过期包围球的视锥裁剪（同边）
  const c = new THREE.Color(0.3, 0.3, 0.3);
  for (let i = 0; i < ids.length; i++) {
    nodeScale.set(ids[i], nodeScale.get(ids[i]) || 1);
    nodeMesh.setColorAt(i, c);
  }
  nodeMesh.renderOrder = 1; // 比边(renderOrder 0)晚画：节点圆盘盖住经过它的边（节点挡边）
  graphGroup.add(nodeMesh);
  // 标签（仅选中/悬停显示）
  for (const n of state.nodes) {
    const lab = makeLabel(n.label);
    lab.visible = false;
    nodeLabels.set(n.id, lab);
    graphGroup.add(lab);
  }
  updateNodePositions();
}

/** 每帧：把 nodePos + nodeScale + 朝向（billboard 正对相机）写进实例矩阵。
 *  对齐旧 Nodes::setCameraDirAti：圆盘始终朝向相机，3D 轨道下也正对 → 拾取稳定（修复 hover/点击时灵时不灵）。 */
const _NODE_Z = new THREE.Vector3(0, 0, 1);
const _NODE_TO_CAM = new THREE.Vector3();
function updateNodePositions() {
  if (!nodeMesh) return;
  const dn = new THREE.Object3D();
  // 盘面统一朝向"视图方向的反向"（指向相机面），而非各自朝向相机那一个点：
  // 纠正偏离中心节点被拉成椭圆（相机点方向对离轴节点不再垂直于视图轴）。
  camera.getWorldDirection(_NODE_TO_CAM);
  _NODE_TO_CAM.negate().normalize();
  for (let i = 0; i < instNode.length; i++) {
    const p = nodePos.get(instNode[i]);
    if (!p) continue;
    const s = nodeScale.get(instNode[i]) || 1;
    dn.quaternion.setFromUnitVectors(_NODE_Z, _NODE_TO_CAM); // 盘面法向(+Z)指向相机面
    dn.position.copy(p);
    dn.scale.set(s, s, 1);
    dn.updateMatrix();
    nodeMesh.setMatrixAt(i, dn.matrix);
  }
  nodeMesh.instanceMatrix.needsUpdate = true;
  // InstancedMesh.raycast 会用 this.boundingSphere 做预排除；布局每帧移动节点，必须每帧重算，
  // 否则漂到外围的节点（出/入度为 0 的边界点）超出过期包围球后被整批排除，导致无法 hover/选中。
  if (nodeMesh.count > 0) {
    nodeMesh.computeBoundingSphere();
    nodeMesh.boundingSphere.radius += 6; // 预留圆盘半径余量，防止掠射命中被球面预排除
  }
}

/** 选中/悬停 → 每实例颜色 + 编码两态位（对齐旧 Nodes::applyColor；alpha 由节点着色器按位解码） */
function updateNodeColors() {
  if (!nodeMesh) return;
  const c = new THREE.Color();
  for (let i = 0; i < instNode.length; i++) {
    const id = instNode[i];
    nodeColorFor(id, c);
    // 量化到 0.01，保证 encode/decode 位稳定（fract(fract(channel)*100) 判定不串位）
    c.r = Math.round(c.r * 100) / 100;
    c.g = Math.round(c.g * 100) / 100;
    c.b = Math.round(c.b * 100) / 100;
    const sel = selectedIds.has(id) || highlightIds.has(id);
    const hov = hoverId === id;
    if (sel) c.r += 0.002; // 选中位（对齐旧 encodeIntoRgb(0.2/100)）
    if (hov) c.g += 0.002; // 悬停位
    nodeMesh.setColorAt(i, c);
    const lab = nodeLabels.get(id);
    if (lab) lab.visible = selectedIds.has(id) || highlightIds.has(id) || hoverId === id;
  }
  if (nodeMesh.instanceColor) nodeMesh.instanceColor.needsUpdate = true;
}

// ---------- 自动上色：按流 color-by-flow（对齐旧项目 Ctrl+H flowColor / Ctrl+Alt+H 清除未选中） ----------
// 流色按"图"记忆（以节点集合的哈希为 key）：同图刷新/重渲染自动恢复，换新图则清空 → 既不丢色也不残留旧色
const flowColored = new Set(); // 当前带流色的节点集合（对齐旧 nodesObj->colorSpecified）
const flowColorRatio = new Map(); // nodeId -> 0..1（节点在流向中的纵向位置）
const FLOW_START = new THREE.Color(0.85, 0.85, 0); // 黄
const FLOW_END = new THREE.Color(1, 0, 1);         // 洋红
const FLOW_STORE_KEY = "shishan-flow-color";
const VIEW_TOGGLE_KEY = "shishan-graph-toggles";
const HISTORY_OPEN_KEY = "shishan-history-open";
/** 搜索历史面板默认展开；点标题切换并持久化。 */
let historyOpen = true;
/** 节点集合的稳定小哈希（与顺序无关），作为"哪张图"的标识。 */
function graphKey(nodes) {
  let h = 7;
  const ids = nodes.map((n) => n.id).sort();
  for (const s of ids) for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
function readFlowStore() {
  try { return JSON.parse(localStorage.getItem(FLOW_STORE_KEY) || "null") || {}; } catch { return {}; }
}
function writeFlowStore(key, coloredIds) {
  try { localStorage.setItem(FLOW_STORE_KEY, JSON.stringify({ key, colored: coloredIds })); } catch { /* 忽略 */ }
}
function persistViewToggles() {
  try { localStorage.setItem(VIEW_TOGGLE_KEY, JSON.stringify({ dim: dimEdgeOn, dot: dotLayoutOn })); } catch { /* 忽略 */ }
}
/** 读回持久化的维度着色/DOT 布局开关（需在 dimEdgeOn 声明之后再调用）。流色按图由 renderGraph 恢复。 */
function restoreViewToggles() {
  try {
    const t = JSON.parse(localStorage.getItem(VIEW_TOGGLE_KEY) || "{}");
    dimEdgeOn = !!t.dim;
    const st = document.getElementById("dim-state");
    if (st) st.textContent = dimEdgeOn ? "维度着色：开" : "维度着色：关";
    if (t.dot === false || t.dot === true) {
      dotLayoutOn = t.dot;
      const db = document.getElementById("dot-btn");
      if (db) db.textContent = dotLayoutOn ? "NEXT:DOT 开" : "NEXT:DOT 关";
    }
  } catch { persistViewToggles(); }
}
/** 按当前图应用/恢复流色；换新图（key 变）则清空。 */
function applyFlowForGraph() {
  const key = graphKey(state.nodes);
  const stored = readFlowStore();
  const ratioKey = stored.key === key;
  flowColored.clear();
  if (ratioKey && Array.isArray(stored.colored)) {
    for (const id of stored.colored) flowColored.add(id);
    computeFlowColors();
  }
  // key 不同（换新图）→ 不清存也不上色；key 相同才恢复
}

const _FLOW_WHITE = new THREE.Color(1, 1, 1);

/**
 * 用最短路程给每个节点算流位置 ratio = fromTop/(fromTop+toBottom)，对齐旧项目 igraph 实现：
 * fromTop = max over 各源(入度0) 的"源→节点最短路径边数"，toBottom = max over 各汇(出度0) 的"节点→汇最短路径边数"。
 * 规则同旧 getNodeRelativePosition()：从任何源都不可达(孤立/纯环)→0(黄)；到不了任何汇→1(洋红)；length==0→0。
 */
function computeFlowColors() {
  flowColorRatio.clear();
  const ids = state.nodes.map((n) => n.id);
  const nodeSet = new Set(ids);
  if (!ids.length) return;
  const out = new Map(), inc = new Map();
  for (const id of ids) { out.set(id, []); inc.set(id, []); }
  for (const e of state.edges) {
    if (nodeSet.has(e.from) && nodeSet.has(e.to)) {
      out.get(e.from).push(e.to);
      inc.get(e.to).push(e.from);
    }
  }
  // 入度 0 = 源（旧 prepareInDegreeMap），出度 0 = 汇；seed 顺序与显示顺序一致，保证稳定。
  const sources = ids.filter((id) => inc.get(id).length === 0);
  const sinks = ids.filter((id) => out.get(id).length === 0);
  const distTop = farthestShortest(out, sources);   // 离"最近源"的路程（不可达则无记录）
  const distBottom = farthestShortest(inc, sinks);  // 反向算：离"最近汇"的路程
  for (const id of ids) {
    const fromTop = distTop.get(id) ?? -1;
    const toBottom = distBottom.get(id) ?? -1;
    let ratio;
    if (fromTop < 0) ratio = 0;
    else if (toBottom < 0) ratio = 1;
    else { const len = fromTop + toBottom; ratio = len === 0 ? 0 : fromTop / len; }
    flowColorRatio.set(id, ratio);
  }
}

/** 多源 BFS（单位边权 = 最短路径边数）：从每个 seed 各跑一次取逐节点 max，对齐旧 maxDistanceFromTop/ToBottom。 */
function farthestShortest(adj, seeds) {
  const dist = new Map();
  for (const s of seeds) {
    const seen = new Map([[s, 0]]);
    let frontier = [s];
    while (frontier.length) {
      const next = [];
      for (const u of frontier) {
        const du = seen.get(u) + 1;
        for (const v of adj.get(u)) {
          if (!seen.has(v)) { seen.set(v, du); next.push(v); }
        }
      }
      frontier = next;
    }
    for (const [v, d] of seen) {
      const cur = dist.get(v);
      if (cur === undefined || d > cur) dist.set(v, d);
    }
  }
  return dist;
}

function enableFlowColor() {
  computeFlowColors();
  // 对齐旧 flowColor()：默认给所有节点上流色（不覆盖已有指定颜色——当前仅流色，故全加）
  for (const n of state.nodes) flowColored.add(n.id);
  writeFlowStore(graphKey(state.nodes), [...flowColored]); // 按当前图记住着色
  applyHighlights();
}
/** 对齐旧 clearSpecifiedColor()（Ctrl+Alt+H）：清除未选中节点的颜色，选中的保留。 */
function clearUnselectedColor() {
  for (const id of [...flowColored]) {
    if (!selectedIds.has(id)) flowColored.delete(id);
  }
  writeFlowStore(graphKey(state.nodes), [...flowColored]);
  applyHighlights();
}

/** 顶部菜单栏（IDE 风格）：点标题展开下拉，点项触发，快捷键显示在项右侧。 */
function initMenubar() {
  const bar = document.getElementById("menubar");
  const closeAll = () => bar.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open"));
  bar.querySelectorAll(".menu-title").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const host = document.getElementById(btn.dataset.menu);
      const was = host.classList.contains("open");
      closeAll();
      if (!was) host.classList.add("open");
    });
  });
  document.addEventListener("click", (e) => { if (!bar.contains(e.target)) closeAll(); });
  document.getElementById("mi-flow-color").addEventListener("click", () => { closeAll(); enableFlowColor(); });
  document.getElementById("mi-clear-color").addEventListener("click", () => { closeAll(); clearUnselectedColor(); });
  document.getElementById("mi-dim-edge").addEventListener("click", () => { closeAll(); toggleDimEdges(); });
  // 沿边选点（对齐旧 selectUpward/selectDownward 及 Ctrl 闭包版）
  document.getElementById("mi-sel-up").addEventListener("click", () => { closeAll(); selectAlongEdges(-1, false); });
  document.getElementById("mi-sel-down").addEventListener("click", () => { closeAll(); selectAlongEdges(1, false); });
  document.getElementById("mi-sel-up-all").addEventListener("click", () => { closeAll(); selectAlongEdges(-1, true); });
  document.getElementById("mi-sel-down-all").addEventListener("click", () => { closeAll(); selectAlongEdges(1, true); });
}

/** 标签只显示在选中/悬停节点上 */
function makeLabel(text) {
  const label = text.length > 22 ? text.slice(0, 22) + "…" : text;
  const fontPx = 64; // 大字号（相对节点更醒目）
  const padX = 16, padY = 12;
  const probe = document.createElement("canvas").getContext("2d");
  probe.font = `${fontPx}px system-ui, sans-serif`;
  const textW = Math.ceil(probe.measureText(label).width);
  const logW = textW + padX * 2, logH = fontPx + padY * 2; // 逻辑尺寸（世界坐标映射用）
  // 超采样：按 devicePixelRatio 放大画布像素，缩小显示时字形笔画保持锐利、不因缩小模糊而变粗
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(logW * dpr));
  canvas.height = Math.max(1, Math.round(logH * dpr));
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.font = `${fontPx}px system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  // 细描边提升与任意底色（含亮色流色/选中）的对比度——旧项目未做，属针对居中叠字的改进
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(4, Math.round(fontPx * 0.12)); // 较重的深色描边，保证对比度
  ctx.strokeStyle = "rgba(13,17,23,0.95)";
  ctx.strokeText(label, padX, logH / 2);
  ctx.fillStyle = "#e6edf3";
  ctx.fillText(label, padX, logH / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearMipmapLinearFilter; // 缩小采样更柔和，避免笔画糊成粗块
  tex.anisotropy = Math.max(4, window.devicePixelRatio >= 2 ? 8 : 4);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.renderOrder = 2; // 标签始终画在最上层（高于节点 renderOrder=1，避免被节点盘盖住）
  // 使文字在世界坐标里的高度 ≈ 1.5，宽高比随文本长度变化（用逻辑尺寸换算，与画布像素无关）
  const worldH = 1.5;
  const k = worldH / logH;
  sprite.scale.set(logW * k, worldH, 1);
  return sprite;
}

// ---------- 边：相机朝向扁平带状 + 流光（移植旧 FlowLine） ----------
// 每个实例是一张 1x1 平面，每帧按两端点+朝向相机定位；uv.x 沿边方向（供流光），uv.y 横跨宽度。
// ---------- 边：相机朝向扁平带 + 流光（复刻旧项目 FlowLine） ----------
// 旧实现：每条边 = 4 顶点四边形（start,end,end,start），顶点着色器在 GPU 上用
// cross(dir, cameraDir)*lineHalfWidth 做「朝向相机的宽度扩张」（相机只需一个 uniform）；
// 颜色 = 两端点节点色的平滑渐变（顶点0,3=起点色，1,2=终点色；四边形内线性插值即为沿长度的渐变）；
// flow 属性 > -1.5 时画一段移动亮带（起点侧=flow，终点侧=flow-1）。
// 对齐旧项目：边 transparent+depthTest=false，与节点同处透明 pass，节点 renderOrder=1 更后画 → 圆盘盖住边。
const EDGE_CAP = 20000; // 预分配容量（对齐旧 FlowLine::edgeCapacity）
const EDGE_HALF_WIDTH = 0.7; // 每侧半宽；总宽 ≈ 2*half（比原值减半）
const EDGE_INSET = 0.9; // 边端点按节点半径内缩的比例(≈圆盘边缘，避免伸进中心 z-fighting)

const EDGE_VERT = `
attribute vec3 edgePos;
attribute vec3 edgeDir;
attribute vec3 edgeColor;
attribute vec2 edgeUv;
attribute float edgeFlow;
attribute float edgeAlpha;
uniform float lineHalfWidth;
uniform vec3 camDir;
varying vec2 vUv;
varying vec3 vColor;
varying float vFlow;
varying float vAlpha;
void main() {
  vUv = edgeUv;
  vColor = edgeColor;
  vFlow = edgeFlow;
  vAlpha = edgeAlpha;
  vec3 nd = normalize(cross(edgeDir, camDir) + vec3(1e-5));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(edgePos + nd * lineHalfWidth, 1.0);
}`;
const EDGE_FRAG = `
varying vec2 vUv;
varying vec3 vColor;
varying float vFlow;
varying float vAlpha;
void main() {
  vec3 color = vColor;
  // 流光：vFlow > -1.5 时画一段移动暗带（对齐旧 FlowLine）
  if (vFlow > -1.5) {
    float f = 0.8 * smoothstep(0.2, 0.0, abs(vFlow));
    color -= vec3(f);
  }
  // 边 alpha 随端点选中/悬停（顶点0,3=起点 alpha，1,2=终点 alpha），对齐旧 FlowLine
  gl_FragColor = vec4(color, vAlpha);
}`;

let edgeGeo = null; // 动态 BufferGeometry（容量预分配，写入活跃边的 4 顶点）
let ePosArr = null, eDirArr = null, eColArr = null, eUvArr = null, eFlowArr = null, eAlphaArr = null;

function rebuildEdges() {
  const edges = state.edges.filter((e) => nodePos.has(e.from) && nodePos.has(e.to));
  edgeData = edges.map((e) => ({ from: e.from, to: e.to, label: e.label })); // 保留 label 供按维度着色
  if (edgeMesh) {
    graphGroup.remove(edgeMesh);
    if (edgeGeo) edgeGeo.dispose();
    edgeMesh = null;
    edgeGeo = null;
  }
  const count = edgeData.length;
  if (count === 0) return;
  const cap = Math.max(EDGE_CAP, count);
  const V = cap * 4;
  edgeGeo = new THREE.BufferGeometry();
  ePosArr = new Float32Array(V * 3);
  eDirArr = new Float32Array(V * 3);
  eColArr = new Float32Array(V * 3);
  eUvArr = new Float32Array(V * 2);
  eFlowArr = new Float32Array(V).fill(-2); // -2 = 无流光
  eAlphaArr = new Float32Array(V).fill(0.3); // 边 alpha：默认未选中 0.3，随端点选中更新
  // uv：每边 (-1,-1),(-1,1),(1,1),(1,-1)
  for (let i = 0; i < cap; i++) {
    const b = i * 4;
    eUvArr[(b + 0) * 2 + 0] = -1; eUvArr[(b + 0) * 2 + 1] = -1;
    eUvArr[(b + 1) * 2 + 0] = -1; eUvArr[(b + 1) * 2 + 1] = 1;
    eUvArr[(b + 2) * 2 + 0] = 1; eUvArr[(b + 2) * 2 + 1] = 1;
    eUvArr[(b + 3) * 2 + 0] = 1; eUvArr[(b + 3) * 2 + 1] = -1;
  }
  edgeGeo.setAttribute("edgePos", new THREE.BufferAttribute(ePosArr, 3));
  edgeGeo.setAttribute("edgeDir", new THREE.BufferAttribute(eDirArr, 3));
  edgeGeo.setAttribute("edgeColor", new THREE.BufferAttribute(eColArr, 3));
  edgeGeo.setAttribute("edgeUv", new THREE.BufferAttribute(eUvArr, 2));
  edgeGeo.setAttribute("edgeFlow", new THREE.BufferAttribute(eFlowArr, 1));
  edgeGeo.setAttribute("edgeAlpha", new THREE.BufferAttribute(eAlphaArr, 1));
  const idx = new Uint32Array(cap * 6);
  for (let i = 0; i < cap; i++) {
    const b = i * 4, o = i * 6;
    idx[o + 0] = b; idx[o + 1] = b + 1; idx[o + 2] = b + 2;
    idx[o + 3] = b + 2; idx[o + 4] = b + 3; idx[o + 5] = b;
  }
  edgeGeo.setIndex(new THREE.BufferAttribute(idx, 1));
  const mat = new THREE.ShaderMaterial({
    vertexShader: EDGE_VERT,
    fragmentShader: EDGE_FRAG,
    transparent: true, // 对齐旧 FlowLine：transparent=true + depthTest=false，纯绘制顺序遮挡
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
    uniforms: {
      lineHalfWidth: { value: EDGE_HALF_WIDTH },
      camDir: { value: new THREE.Vector3(0, 0, -1) },
    },
  });
  edgeMesh = new THREE.Mesh(edgeGeo, mat);
  edgeMesh.frustumCulled = false; // 动态增量规模，避免整批被视锥裁剪
  graphGroup.add(edgeMesh);
}

/** 每帧：把当前节点位置/颜色写进边缓冲（跟随力导向移动 / 选中高亮与流上色）。 */
function updateEdgeBuffers() {
  if (!edgeMesh || !edgeGeo) return;
  const n = edgeData.length;
  for (let i = 0; i < n; i++) {
    const e = edgeData[i];
    const a = nodePos.get(e.from), b = nodePos.get(e.to);
    const o = i * 4;
    if (!a || !b) continue;
    // 位置：顶点0,3=起点 a；顶点1,2=终点 b。边端点按各自节点半径内缩到圆盘边缘，
    // 避免伸进节点中心与节点盘在同一深度 z-fighting(3D 真实深度下中心闪)。
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz) || 1e-6;
    const ux = dx / len, uy = dy / len, uz = dz / len;
    const ra = (nodeScale.get(e.from) || 1) * EDGE_INSET;
    const rb = (nodeScale.get(e.to) || 1) * EDGE_INSET;
    const aax = a.x + ux * ra, aay = a.y + uy * ra, aaz = a.z + uz * ra;
    const bbx = b.x - ux * rb, bby = b.y - uy * rb, bbz = b.z - uz * rb;
    ePosArr[(o + 0) * 3] = aax; ePosArr[(o + 0) * 3 + 1] = aay; ePosArr[(o + 0) * 3 + 2] = aaz;
    ePosArr[(o + 1) * 3] = bbx; ePosArr[(o + 1) * 3 + 1] = bby; ePosArr[(o + 1) * 3 + 2] = bbz;
    ePosArr[(o + 2) * 3] = bbx; ePosArr[(o + 2) * 3 + 1] = bby; ePosArr[(o + 2) * 3 + 2] = bbz;
    ePosArr[(o + 3) * 3] = aax; ePosArr[(o + 3) * 3 + 1] = aay; ePosArr[(o + 3) * 3 + 2] = aaz;
    // 方向：起点→终点（顶点0,1），终点→起点（顶点2,3）；着色器里 normalize 后只取朝向，长度无关
    eDirArr[(o + 0) * 3] = dx; eDirArr[(o + 0) * 3 + 1] = dy; eDirArr[(o + 0) * 3 + 2] = dz;
    eDirArr[(o + 1) * 3] = dx; eDirArr[(o + 1) * 3 + 1] = dy; eDirArr[(o + 1) * 3 + 2] = dz;
    eDirArr[(o + 2) * 3] = -dx; eDirArr[(o + 2) * 3 + 1] = -dy; eDirArr[(o + 2) * 3 + 2] = -dz;
    eDirArr[(o + 3) * 3] = -dx; eDirArr[(o + 3) * 3 + 1] = -dy; eDirArr[(o + 3) * 3 + 2] = -dz;
    if (dimEdgeOn) {
      // 按维度平色覆盖（两端同色），区分各轴维度
      edgeDimColorFor(e.label, _EDGE_C0);
      eColArr[(o + 0) * 3] = _EDGE_C0.r; eColArr[(o + 0) * 3 + 1] = _EDGE_C0.g; eColArr[(o + 0) * 3 + 2] = _EDGE_C0.b;
      eColArr[(o + 3) * 3] = _EDGE_C0.r; eColArr[(o + 3) * 3 + 1] = _EDGE_C0.g; eColArr[(o + 3) * 3 + 2] = _EDGE_C0.b;
      eColArr[(o + 1) * 3] = _EDGE_C0.r; eColArr[(o + 1) * 3 + 1] = _EDGE_C0.g; eColArr[(o + 1) * 3 + 2] = _EDGE_C0.b;
      eColArr[(o + 2) * 3] = _EDGE_C0.r; eColArr[(o + 2) * 3 + 1] = _EDGE_C0.g; eColArr[(o + 2) * 3 + 2] = _EDGE_C0.b;
    } else {
      // 颜色：端点节点色渐变（起点色在顶点0,3，终点色在1,2），对齐旧 FlowLine::setColors
      nodeColorFor(e.from, _EDGE_C0);
      nodeColorFor(e.to, _EDGE_C1);
      eColArr[(o + 0) * 3] = _EDGE_C0.r; eColArr[(o + 0) * 3 + 1] = _EDGE_C0.g; eColArr[(o + 0) * 3 + 2] = _EDGE_C0.b;
      eColArr[(o + 3) * 3] = _EDGE_C0.r; eColArr[(o + 3) * 3 + 1] = _EDGE_C0.g; eColArr[(o + 3) * 3 + 2] = _EDGE_C0.b;
      eColArr[(o + 1) * 3] = _EDGE_C1.r; eColArr[(o + 1) * 3 + 1] = _EDGE_C1.g; eColArr[(o + 1) * 3 + 2] = _EDGE_C1.b;
      eColArr[(o + 2) * 3] = _EDGE_C1.r; eColArr[(o + 2) * 3 + 1] = _EDGE_C1.g; eColArr[(o + 2) * 3 + 2] = _EDGE_C1.b;
    }
    // alpha：顶点0,3=起点 alpha，1,2=终点 alpha（对齐旧 FlowLine，端点选中则不透明、未选中半透明）。
    // 维度色已是 sRGB 直存（色相正确），半透明(0.3)下也显示正确色相，无需再强制不透明。
    const aFrom = nodeAlphaFor(e.from);
    const aTo = nodeAlphaFor(e.to);
    eAlphaArr[o + 0] = aFrom; eAlphaArr[o + 3] = aFrom;
    eAlphaArr[o + 1] = aTo;   eAlphaArr[o + 2] = aTo;
  }
  edgeGeo.setDrawRange(0, n * 6);
  edgeGeo.attributes.edgePos.needsUpdate = true;
  edgeGeo.attributes.edgeDir.needsUpdate = true;
  edgeGeo.attributes.edgeColor.needsUpdate = true;
  edgeGeo.attributes.edgeAlpha.needsUpdate = true;
}

const _EDGE_C0 = new THREE.Color();
const _EDGE_C1 = new THREE.Color();
const _EDGE_CAMDIR = new THREE.Vector3();

/** 端点 alpha（对齐旧 FlowLine：选中/高亮 1.0 不透明，未选中 0.3 半透明，悬停 +0.2）。 */
function nodeAlphaFor(id) {
  const base = selectedIds.has(id) || highlightIds.has(id) ? 1.0 : 0.3;
  return Math.min(base + (hoverId === id ? 0.2 : 0), 1.0);
}

// ---------- NEXT 节点 DOT 分层固定布局 ----------
// dotLayoutOn：为 true 时，被 NEXT 连接的节点用 dot（分层）布局并固定位置，不参与力导；
// 其余（非 NEXT）节点照常力导，并受固定节点排斥、绕开它们。
let dotLayoutOn = false;
let dotNodes = new Set();   // 固定骨架节点 id（= 条件节点）
let dotRank = new Map();    // id -> NEXT 执行层 rank（顺序参考，暂不用）
let nextAnchors = new Map(); // NEXT 非条件节点 id -> 归属条件坐标（力导锚点）
let _layoutTelemetry = 0;    // 布局遥测计数（每 ~120 帧上报一次自由点-锚点距离）
// Ranked 定向力导（DAG/flow）：xs=执行层横向间距(列拉力目标)，rankStrength=列拉力强度，ys=层内初始散开间距
// 主链（事件）间距 / Value 数据坑的首行下移量 / 数据坑内上下叠的节距（世界单位）
const DOT_LAYOUT = { cw: 56, levelY: 104, body: 28, bx: 16, anchor: 1.6, nextSpring: 0.6, repFrac: 0.15, rankStrength: 0.10 };

function nodeKind(id) { const n = nodesById.get(id); return n ? (n.kind || n.label || "") : ""; }

/**
 * NEXT 链"Value 降层"布局（固定位置）：
 *  - 主链 = 事件（CalledMethod / Condition），按执行时序（NEXT 拓扑序）排成一条从左到右的线，y=0；
 *  - 数据坑 = Value 节点（实参槽/返回值/读取），放到与其相邻两个事件的横向中点下方（y 下移 gutter），
 *    同一对事件之间的多个 Value 在坑里上下叠（vpitch 节距）。
 * 这样函数的时序一目了然，Value 仍可见（不隐藏）、不占用主链横向步距，线更短更清爽。
 */
function computeDotLayout() {
  if (!dotLayoutOn) { dotNodes.clear(); nextAnchors.clear(); dotRank.clear(); return; } // 默认全量力导
  const prevOf = new Map(), nextOf = new Map(), incident = new Set();
  for (const e of state.edges) {
    if (e.label !== "NEXT") continue;
    if (!nodePos.has(e.from) || !nodePos.has(e.to)) continue;
    incident.add(e.from); incident.add(e.to);
    if (!nextOf.has(e.from)) nextOf.set(e.from, []);
    nextOf.get(e.from).push(e.to);
    if (!prevOf.has(e.to)) prevOf.set(e.to, []);
    prevOf.get(e.to).push(e.from);
  }
  if (incident.size === 0) { dotNodes = incident; dotRank.clear(); return; }
  const ids = [...incident];
  // 1) rank = 最长路径执行层（用于拓扑序 tie-break，让主链单调推进）
  const rank = new Map(); for (const id of ids) rank.set(id, 0);
  for (let g = 0; g < ids.length; g++) {
    let ch = false;
    for (const id of ids) for (const p of prevOf.get(id) || []) {
      if (incident.has(p) && rank.get(p) + 1 > rank.get(id)) { rank.set(id, rank.get(p) + 1); ch = true; }
    }
    if (!ch) break;
  }
  // 2) NEXT 拓扑序（Kahn，待处理按 rank 降序）
  const indeg = new Map(); for (const id of ids) indeg.set(id, 0);
  for (const [f, arr] of nextOf) for (const t of arr) if (incident.has(t)) indeg.set(t, (indeg.get(t) || 0) + 1);
  const ready = ids.filter((id) => (indeg.get(id) || 0) === 0).sort((a, b) => rank.get(b) - rank.get(a));
  const taken = new Set(), seq = [];
  let cur;
  const pop = () => { ready.sort((a, b) => rank.get(b) - rank.get(a)); return ready.pop(); };
  while ((cur = pop()) !== undefined) {
    if (taken.has(cur)) continue;
    taken.add(cur); seq.push(cur);
    for (const t of nextOf.get(cur) || []) {
      if (!incident.has(t) || taken.has(t)) continue;
      const d = (indeg.get(t) || 0) - 1; indeg.set(t, d);
      if (d === 0) ready.push(t);
    }
  }
  for (const id of ids) if (!taken.has(id)) seq.push(id); // 环剩余节点兜底
  // 3) 条件决策树骨架（自上而下）：从 METHOD 根条件出发，按 SUB(then嵌套)/ELSE(else分支) 递归下沉，
  //    x 按 DFS 访问序、y 按层级(levelY)；事件(调用/Value)填在归属条件的下方一行(owner 错开)。
  const isCond = (id) => nodeKind(id) === "Condition";
  const condSet = new Set(ids.filter(isCond));
  const subOf = new Map(), elseOf = new Map(), hasParent = new Set();
  for (const e of state.edges) {
    if (!condSet.has(e.from) || !condSet.has(e.to)) continue;
    if (e.label === "SUB") {
      if (!subOf.has(e.from)) subOf.set(e.from, []);
      subOf.get(e.from).push(e.to); hasParent.add(e.to);
    } else if (e.label === "ELSE") {
      elseOf.set(e.from, e.to); hasParent.add(e.to);
    }
  }
  let nextX = 0;
  if (condSet.size > 0) {
    const rootTargets = new Set();
    for (const e of state.edges) if (e.label === "ROOT" && condSet.has(e.to)) rootTargets.add(e.to);
    let rootConds = [...rootTargets];
    if (rootConds.length === 0) rootConds = [...condSet].filter((c) => !hasParent.has(c));
    if (rootConds.length === 0) rootConds = [...condSet];
    const visitedCond = new Set();
    // 紧凑树：x 由"叶子"决定(每叶一列 STEP，节点 x=子节点集的中点)，兄弟同层靠拢、跨度小。
    let leafCounter = 0;
    const kidsOf = (c) => { const k = subOf.get(c) || []; if (elseOf.has(c)) k.push(elseOf.get(c)); return k; };
    const assignX = (c, depth) => {
      if (visitedCond.has(c)) return;
      visitedCond.add(c);
      const kids = kidsOf(c);
      if (kids.length === 0) {
        const posX = leafCounter * DOT_LAYOUT.cw;
        leafCounter++;
        nodePos.get(c).set(posX, depth * DOT_LAYOUT.levelY, 0);
        return posX;
      }
      let mn = Infinity, mx = -Infinity;
      for (const k of kids) { const kx = assignX(k, depth + 1); if (kx < mn) mn = kx; if (kx > mx) mx = kx; }
      const cx = (mn + mx) / 2;
      nodePos.get(c).set(cx, depth * DOT_LAYOUT.levelY, 0);
      return cx;
    };
    for (const r of rootConds) assignX(r, 0);
    for (const c of condSet) if (!visitedCond.has(c)) { nodePos.get(c).set(leafCounter++ * DOT_LAYOUT.cw, 0, 0); }
  }
  // 4) 整体居中：先把条件骨架平移到原点附近；之后再按居中后的条件坐标算自由点锚点，保证坐标一致。
  if (condSet.size > 0) {
    let cx = 0, cy = 0;
    for (const id of condSet) { const p = nodePos.get(id); cx += p.x; cy += p.y; }
    cx /= condSet.size; cy /= condSet.size;
    for (const id of condSet) { const p = nodePos.get(id); p.x -= cx; p.y -= cy; }
  }
  // 事件(非条件)：不固定、交给力导；按"居中后"的条件坐标给每节点一个归属条件下方的强锚点，
  // 使其在对应决策点附近铺开、又不被邻居斥力弹飞。
  nextAnchors.clear();
  if (condSet.size > 0) {
    const firstCond = seq.find(isCond);
    const ownerSlots = new Map();
    let last = null;
    for (const id of seq) {
      if (condSet.has(id)) { last = id; continue; }
      const owner = last != null ? last : firstCond;
      if (owner != null) {
        const op = nodePos.get(owner);
        const k = ownerSlots.get(owner) || 0; ownerSlots.set(owner, k + 1);
        nextAnchors.set(id, { x: op.x + (k + 1) * DOT_LAYOUT.bx, y: op.y + DOT_LAYOUT.body });
        const p = nodePos.get(id);
        p.set(op.x + (k + 1) * DOT_LAYOUT.bx, op.y + DOT_LAYOUT.body, 0); // 初始即在锚点
      }
    }
  }
  dotNodes = condSet; dotRank.clear(); // 只固定条件骨架；其余 NEXT 节点交给力导（锚点 nextAnchors 聚拢）
  // 5) 去重叠：固定节点靠得太近时，把可动的 Value 微微推开（主链事件保持 y=0 不动）
  resolveFixedOverlaps(ids, 6);
}

/** 固定布局去重叠：推挤靠得过近的节点；主链事件（CalledMethod/Condition）保持原位，只动 Value。 */
function resolveFixedOverlaps(ids, minSep) {
  const arr = [];
  for (const id of ids) { const v = nodePos.get(id); if (v) arr.push({ id, x: v.x, y: v.y }); }
  const isEvent = (id) => { const k = nodeKind(id); return k === "CalledMethod" || k === "Condition"; };
  for (let iter = 0; iter < 10; iter++) {
    let moved = false;
    for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
      const A = arr[i], B = arr[j];
      const dx = B.x - A.x, dy = B.y - A.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 1e-6 || d2 >= minSep * minSep) continue;
      const d = Math.sqrt(d2);
      const push = (minSep - d) / 2;
      const ux = dx / d, uy = dy / d;
      const Ai = !isEvent(A.id), Bi = !isEvent(B.id); // 可带动:Value
      if (Ai && Bi) { A.x -= ux * push; A.y -= uy * push; B.x += ux * push; B.y += uy * push; moved = true; }
      else if (Ai) { A.x -= ux * push * 2; A.y -= uy * push * 2; moved = true; }
      else if (Bi) { B.x += ux * push * 2; B.y += uy * push * 2; moved = true; }
      // 两事件已由间距参数避开，重叠则跳过不动
    }
    for (const o of arr) { const v = nodePos.get(o.id); v.x = o.x; v.y = o.y; }
    if (!moved) break;
  }
}

// ---------- 按维度着色边（时序/数据两轴 + 逻辑 ↔ 边颜色） ----------
let dimEdgeOn = false;
const EDGE_DIM_OF = {
  // 时机（时序主轴）：语句按执行先后
  NEXT: "timing",
  // 时机的分形：一次调用内嵌一段新的执行时序（自相似递归）
  CALLS: "timingFractal",
  // 数据（主轴）：值流动
  FLOWS: "data",
  // 数据的分形：访问成员 / 数组下标（结构自相似嵌套）
  REF: "dataFractal", REFERENCES: "dataFractal", INDEX: "dataFractal",
  // 逻辑：条件树（独立维度，ROOT/SUB/ELSE 骨架 + CONTROLS 进入 + LEADS_TO 出口）
  ROOT: "logic", SUB: "logic", ELSE: "logic", CONTROLS: "logic", LEADS_TO: "logic",
};
/** 按 sRGB 十六进制构色，跳过 ColorManagement 的 sRGB→线性转换。
 *  本应用边用自定义 ShaderMaterial 原样输出颜色，若 new THREE.Color(0x…) 把它转成线性，
 *  再直接写进 sRGB 画布会整体变暗（#e8a33d → #ce5d0c）。这里按"最终显示值(sRGB)"直接存分量，
 *  shader 原样输出即得图例色。 */
function srgbHex(hex) {
  return new THREE.Color().setRGB(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);
}
const EDGE_DIM_COLOR = {
  timing:        srgbHex(0x56d3e0), // 青(轻) 时机 NEXT（时序主轴，沿用旧"顺序"的青色）
  timingFractal: srgbHex(0x2f9ec4), // 中青(略重) 时机的分形 CALLS（同族稍深，调用=内嵌时序）
  data:          srgbHex(0x2fb95c), // 翠绿   数据 FLOWS（绿家族，暖绿）
  dataFractal:   srgbHex(0x2aa47a), // 中绿(略重) 数据的分形 REF/INDEX（结构纵深）
  logic:         srgbHex(0x2f80ed), // 亮蓝   逻辑 条件树（独立，理性蓝）
  other:         srgbHex(0x8b949e), // 中性灰 未纳入
};
/** 边 label → 维度颜色；未纳入各轴维度的（DECLARES/HAS_PARAM/RETURNS/ARG_OF…）归为灰。 */
function edgeDimColorFor(label, out) {
  const dim = EDGE_DIM_OF[label] || "other";
  out.copy(EDGE_DIM_COLOR[dim]);
}
function toggleDimEdges() {
  dimEdgeOn = !dimEdgeOn;
  persistViewToggles();
  const st = document.getElementById("dim-state");
  if (st) st.textContent = dimEdgeOn ? "维度着色：开" : "维度着色：关";
}

/** 节点当前视觉色（正常模式灰度 / 流上色模式渐变，选中/悬停提亮）。节点与边共用，保证边色随节点色。 */
const _NODE_WHITE = new THREE.Color(1, 1, 1);
function nodeColorFor(id, out) {
  const sel = selectedIds.has(id) || highlightIds.has(id);
  const hov = hoverId === id;
  if (flowColored.has(id)) {
    const r = flowColorRatio.get(id) ?? 0;
    out.copy(FLOW_START).lerp(FLOW_END, r);
    // 选中不改颜色（对齐旧项目：选中仅 alpha 提到 1.0 变不透明，颜色保持），仅悬停轻微提亮
    if (hov) out.lerp(_NODE_WHITE, 0.35);
  } else {
    const g = sel ? (hov ? 1.0 : 0.9) : (hov ? 0.55 : 0.28);
    out.setRGB(g, g, g);
  }
  return out;
}

// ---------- 布局：连续力导向仿真（移植旧 FR，让节点涌动沉降） ----------
// target/refTarget 是相邻节点的弹簧平衡距离；调大让节点摊开，连线在盘间隙里可见。
const LAYOUT = { repulsion: 5, minDist: 1.4, refTarget: 11, target: 7, spring: 0.02, center: 0.05, temperature: 0.22 };

function stepLayout(dt) {
  const nodes = state.nodes;
  const n = nodes.length;
  if (!n) return;
  const k = Math.min(dt / 16.666, 2) * LAYOUT.temperature * intensityMul;
  // 力导中鼠标拖拽的节点：先快照其位置，布局计算后还原（该节点不被力导移走，其余照常动画）
  const dv0 = dragNodeId != null ? nodePos.get(dragNodeId) : null;
  _dragPin = dv0 ? dv0.clone() : null;
  // 斥力（自由点之间；固定骨架点不参与斥力——它们不推走自由节点，自由点才能贴紧骨架并被引力拉拢）
  for (let i = 0; i < n; i++) {
    const a = nodePos.get(nodes[i].id);
    const af = dotNodes.has(nodes[i].id);
    for (let j = i + 1; j < n; j++) {
      const b = nodePos.get(nodes[j].id);
      const bf = dotNodes.has(nodes[j].id);
      if (af || bf) continue; // 任一端是固定骨架点 → 不斥力
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      let dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < 1e-6) { if (!af) a.x += (Math.random() - 0.5) * 0.01; if (!bf) b.x += (Math.random() - 0.5) * 0.01; dist = 1e-6; }
      const d = Math.max(dist, LAYOUT.minDist);
      const rep = dotLayoutOn ? DOT_LAYOUT.repFrac : 1; // 骨架模式把自由点间斥力调小，避免其被彼此炸远
      const f = (k * LAYOUT.repulsion * rep) / (d * d);
      const fx = (f * dx) / d, fy = (f * dy) / d, fz = (f * dz) / d;
      if (!af) { a.x -= fx; a.y -= fy; a.z -= fz; }
      if (!bf) { b.x += fx; b.y += fy; b.z += fz; }
    }
  }
  // 弹簧（边；固定单线节点不被拖走，只移动非固定端）
  for (const e of state.edges) {
    const a = nodePos.get(e.from);
    const b = nodePos.get(e.to);
    if (!a || !b) continue;
    const af = dotNodes.has(e.from), bf = dotNodes.has(e.to);
    if (af && bf) continue;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 1e-6) continue;
    const target = e.label === "REFERENCES" ? LAYOUT.refTarget : LAYOUT.target;
    // 仅骨架模式对 NEXT 边用强弹簧；默认全量力导则所有边用统一弹簧。
    const s = (dotLayoutOn && e.label === "NEXT") ? LAYOUT.spring * DOT_LAYOUT.nextSpring : LAYOUT.spring;
    const fx = ((dist - target) / dist) * dx * k * s;
    const fy = ((dist - target) / dist) * dy * k * s;
    const fz = ((dist - target) / dist) * dz * k * s;
    if (!af) { a.x += fx; a.y += fy; a.z += fz; }
    if (!bf) { b.x -= fx; b.y -= fy; b.z -= fz; }
  }
  // 锚点力：NEXT 非骨架节点(调用/Value)在条件骨架框架内力导聚拢到各自归属条件
  if (dotLayoutOn && nextAnchors.size) {
    const kk = Math.min(dt / 16.666, 2) * LAYOUT.temperature;
    for (const [id, a] of nextAnchors) {
      const v = nodePos.get(id);
      if (!v) continue;
      v.x += (a.x - v.x) * kk * DOT_LAYOUT.anchor;
      v.y += (a.y - v.y) * kk * DOT_LAYOUT.anchor;
    }
  }
  // 居中（拉向当前质心防漂移；固定单线节点保持单线布局位置，不参与居中）
  let cx = 0, cy = 0, cz = 0, cnt = 0;
  for (const v of nodePos.values()) { cx += v.x; cy += v.y; cz += v.z; cnt++; }
  cx /= cnt; cy /= cnt; cz /= cnt;
  for (const nd of nodes) {
    if (dotNodes.has(nd.id)) continue;
    if (nextAnchors.has(nd.id)) continue; // 有独立体槽锚点，交给锚点力，不被居中拽走
    const v = nodePos.get(nd.id);
    if (!v) continue;
    v.x -= cx * k * LAYOUT.center;
    v.y -= cy * k * LAYOUT.center;
    v.z -= cz * k * LAYOUT.center;
  }
  if (layoutMode === "2d") for (const v of nodePos.values()) v.z = 0;
  // 布局遥测：每 ~2s 报"自由点到最近条件节点"的距离分布与坐标样本，供外部读日志定向调参
  if (nextAnchors.size && (++_layoutTelemetry % 120) === 1) {
    const conds = [];
    for (const id of dotNodes) { const v = nodePos.get(id); if (v) conds.push(v); }
    let n = 0, sum = 0, maxD = 0, near = 0, spr = "";
    for (const [id] of nextAnchors) {
      const v = nodePos.get(id); if (!v) continue;
      let best = Infinity;
      for (const cv of conds) { const dd = Math.hypot(v.x - cv.x, v.y - cv.y); if (dd < best) best = dd; }
      n++; sum += best; if (best > maxD) maxD = best;
      if (best < 60) near++;
    }
    let s3 = "";
    let i3 = 0;
    for (const [id] of nextAnchors) {
      if (i3++ >= 3) break;
      const v = nodePos.get(id); if (!v) continue;
      s3 += ` [${v.x.toFixed(0)},${v.y.toFixed(0)}]`;
    }
    let cl = "";
    let ci3 = 0;
    for (const id of dotNodes) { const v = nodePos.get(id); if (v) { cl += ` c[${v.x.toFixed(0)},${v.y.toFixed(0)}]`; if (++ci3 >= 4) break; } }
    // 报第一个自由点自身的锚点坐标与归属条件坐标
    let anc = "";
    if (nextAnchors.size) {
      const fid = nextAnchors.keys().next().value;
      const a = nextAnchors.get(fid);
      const v = nodePos.get(fid);
      anc = ` anchor1=[${a.x.toFixed(0)},${a.y.toFixed(0)}] at=[${v ? v.x.toFixed(0) : "?"},${v ? v.y.toFixed(0) : "?"}]`;
    }
    console.log(`[DBG][LAYOUT] free=${n} avgNC=${(sum / n).toFixed(1)} max=${maxD.toFixed(1)} in60=${near}${cl}${anc} sample${s3}`);
  }
  // 力导中被拖拽的节点：位置由鼠标决定，布局计算后强制还原，不被力导移走；其余节点照常动画
  if (dragNodeId != null) {
    const dv = nodePos.get(dragNodeId);
    if (dv && _dragPin) dv.copy(_dragPin);
  }
  updateNodePositions(); // 布局每帧更新实例矩阵
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
    const s = isRoot ? 3.2 : THREE.MathUtils.clamp(1.6 * Math.sqrt(dist * 0.6), 0.9, 2.4);
    nodeScale.set(node.id, s);
  }
  updateNodePositions();
}

function updateLabelPositions() {
  // 3D 下标签沿相机方向前移一点，behind 自己的节点不被挡住(但仍会被更近的其它节点遮挡)
  let dir = null;
  if (layoutMode === "3d" && camera) {
    dir = new THREE.Vector3();
    camera.getWorldDirection(dir); // 相机朝向；标签前端 = 背离相机即沿 -dir
  }
  for (const [id, lab] of nodeLabels) {
    const v = nodePos.get(id);
    if (!v) continue;
    lab.position.copy(v);
    if (dir) lab.position.addScaledVector(dir, -0.6); // 朝相机推 0.6，略在节点之前
  }
}

/** 应用灰盘明暗/透明度（对齐旧项目 Nodes：未选中灰0.5·alpha0.3，选中亮灰0.9·alpha1.0，悬停 +0.2） */
function applyHighlights() {
  updateNodeColors();
}

// ---------- 相机 / 控制器（2D 平移缩放 + 3D 轨道） ----------
function cameraForMode() {
  if (layoutMode === "2d") {
    camera = orthoCamera;
    const aspect = window.innerWidth / window.innerHeight;
    const hh = viewHeight / 2;
    orthoCamera.left = -hh * aspect;
    orthoCamera.right = hh * aspect;
    orthoCamera.top = hh;
    orthoCamera.bottom = -hh;
    orthoCamera.aspect = aspect;
    orthoCamera.position.set(viewTarget.x, viewTarget.y, 100);
    orthoCamera.lookAt(viewTarget.x, viewTarget.y, 0);
    orthoCamera.rotateZ(viewRotZ); // 2D 绕 Z 旋转（roll）
    orthoCamera.updateProjectionMatrix();
  } else {
    camera = perspCamera;
  }
}

// ---------- 缩放拖拽条（放大 / 缩小画面，2D 正交/3D 透视通用，与滚轮双向同步） ----------
const ZOOM_H_MIN = 60, ZOOM_H_MAX = 4000;   // 2D 正交视图高度范围
const ZOOM_D_MIN = 5, ZOOM_D_MAX = 2000;    // 3D 透视相机距离范围
let zoomDragging = false;
function zoomFromHeight(h) {
  const c = Math.max(ZOOM_H_MIN, Math.min(ZOOM_H_MAX, h));
  return Math.round((100 * Math.log(c / ZOOM_H_MAX)) / Math.log(ZOOM_H_MIN / ZOOM_H_MAX));
}
function heightFromZoom(v) {
  const p = Math.max(0, Math.min(100, v)) / 100;
  return ZOOM_H_MAX * Math.pow(ZOOM_H_MIN / ZOOM_H_MAX, p);
}
function zoomFromDist(d) {
  const c = Math.max(ZOOM_D_MIN, Math.min(ZOOM_D_MAX, d));
  return Math.round((100 * Math.log(c / ZOOM_D_MAX)) / Math.log(ZOOM_D_MIN / ZOOM_D_MAX));
}
function distFromZoom(v) {
  const p = Math.max(0, Math.min(100, v)) / 100;
  return ZOOM_D_MAX * Math.pow(ZOOM_D_MIN / ZOOM_D_MAX, p);
}
function applyZoom() {
  const v = +zoomEl.value;
  if (layoutMode === "2d") {
    viewHeight = heightFromZoom(v);
  } else {
    const d = distFromZoom(v);
    const dir = camera.position.clone().sub(controls.target);
    if (dir.lengthSq() < 1e-9) dir.set(0, 0, 1);
    dir.normalize();
    camera.position.copy(controls.target).addScaledVector(dir, d);
    controls.update();
  }
}
zoomEl.addEventListener("pointerdown", () => { zoomDragging = true; });
zoomEl.addEventListener("input", applyZoom);
zoomEl.addEventListener("pointerup", () => { zoomDragging = false; });
zoomEl.addEventListener("pointercancel", () => { zoomDragging = false; });

// ---------- 力导剧烈程度（布局温度）拖拽条 ----------
// 映射 0-100 -> 力导温度乘子，默认 50 = ×1.0（对应原 LAYOUT.temperature）
let intensityMul = 1;
const intensityEl = document.getElementById("intensity");
function applyIntensity() {
  const v = (+intensityEl.value || 50) / 100;
  intensityMul = 0.05 * Math.pow(400, v); // v=0→0.05x, v=0.5→1x, v=1→20x；默认 50=1x
}
intensityEl.addEventListener("input", applyIntensity);
applyIntensity();

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
  if (layoutMode === "2d") {
    viewHeight = Math.max(ZOOM_H_MIN, maxR * 2.4 + 40);
  } else {
    controls.target.copy(viewTarget);
    camera.position.set(cx + maxR * 1.6 + 8, cy + maxR + 8, cz + maxR * 1.6 + 8);
    controls.update();
  }
}

// ---------- 探针 / 交互 ----------
function pickNode(clientX, clientY) {
  if (!nodeMesh) return null;
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(nodeMesh, false);
  if (!hits.length) return null;
  const ix = hits[0].instanceId;
  return ix != null && ix < instNode.length ? instNode[ix] : null;
}

const drag = { active: false, button: -1, startX: 0, startY: 0, lastX: 0, lastY: 0, moved: false };
let dragNodeId = null; // 力导中鼠标拖拽的节点 id（2D/3D，命中节点时置位）
let _drag3d = null; // 3D 拖拽平面：{dir, d}（垂直于相机、过节点起始位置）
let _dragPin = null;   // stepLayout 中被拖节点的鼠标位快照（力导后还原）
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
  const lines = [`kind: ${escHtml(n.kind || "-")}`];
  // Value 节点：额外显示子类型（实参槽/返回值/字段/局部变量…）与读/写
  if (n.kind === "Value") {
    const sub = n.subkind || "-";
    lines.push(`value kind: ${escHtml(sub)}${n.access ? ` (${escHtml(n.access)})` : ""}`);
  }
  if (n.symbol) lines.push(`symbol: ${escHtml(n.symbol)}`);
  lines.push(`label: ${escHtml(n.label || id)}`);
  if (n.stableId) lines.push(`id: ${escHtml(n.stableId)}`);
  return lines.join("\n");
}

function ensureTooltip() {
  if (tooltipEl) return tooltipEl;
  tooltipEl = document.createElement("div");
  tooltipEl.className = "node-tooltip";
  tooltipEl.style.cssText =
    "position:fixed;z-index:40;pointer-events:none;background:rgba(13,17,23,.93);color:#c9d1d9;" +
    "border:1px solid #30363d;border-radius:6px;padding:6px 9px;font:12px/1.5 system-ui,sans-serif;" +
    "white-space:pre-wrap;display:none;max-width:560px;overflow-wrap:anywhere;word-break:break-all;";
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
  selectedIds = seen;
  activeId = id;
  syncSelectionUI();
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
  selectedIds = seen;
  activeId = id;
  syncSelectionUI();
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
  console.log(`[DBG] click id=${id} kind=${(nodesById.get(id) || {}).kind} inNodeIx=${nodeIx.has(id)}`);
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
    selectOnly(id);
    focusNode(id);
    return;
  }
  lastClick.id = id;
  lastClick.time = now;
  toggleSelect(id); // 单击：切换选中（多选，对齐旧项目）
}

function setupInteraction() {
  const el = renderer.domElement;

  // 触屏：双保险阻止浏览器默认手势——CSS touch-action:none 兜底 + 此处 preventDefault
  // （防止旧 iOS 在 touch-action 未生效时仍滚动/缩放页面，从而抛 pointercancel 中断交互）。
  for (const t of ["touchstart", "touchmove"]) {
    el.addEventListener(t, (e) => e.preventDefault(), { passive: false });
  }
  // 触屏多指跟踪：pointerId -> {x, y}。单指=2D 平移/拖节点，双指=捏合缩放；3D 单指旋转交给 ThreeDControls。
  const touchPoints = new Map();
  let pinchActive = false;
  let pinchDist = 0;
  // 触屏悬停/长按：按下即“悬停”高亮+tooltip，抬起取消；长按节点弹出右键菜单（统一移动端，含不支持
  // contextmenu 事件的 iOS）。移动/抬手/变双指会取消长按。
  const LONG_PRESS_MS = 500;
  let pressTimer = null;
  let pressActive = false;   // 单指按压进行中（用于长按判定与原生 contextmenu guard）
  let pressPos = { x: 0, y: 0 };
  let longPressFired = false; // 本次按压是否已长按出菜单（抬手时不再当 tap 选中）
  function setHoverAt(x, y) {
    const id = pickNode(x, y);
    if (id !== hoverId) { hoverId = id; applyHighlights(); }
    if (id) showTooltipAt(x, y, nodeInfoHtml(id));
    else hideTooltip();
  }
  function clearHoverAt() {
    if (hoverId != null) { hoverId = null; applyHighlights(); }
    hideTooltip();
  }

  const downAt = { x: 0, y: 0, button: -1, active: false };
  el.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch") {
      try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touchPoints.size === 1) {
        downAt.x = e.clientX;
        downAt.y = e.clientY;
        downAt.button = 0;
        downAt.active = true;
        // touch：按下即“悬停”高亮 + tooltip
        setHoverAt(e.clientX, e.clientY);
        // 长按节点 → 右键菜单；移动/抬手/变双指会取消
        pressPos.x = e.clientX;
        pressPos.y = e.clientY;
        pressActive = true;
        longPressFired = false;
        clearTimeout(pressTimer);
        pressTimer = setTimeout(() => {
          if (!pressActive) return;
          const id = pickNode(pressPos.x, pressPos.y);
          if (id != null) {
            longPressFired = true;
            hideTooltip(); // 菜单弹出，收掉 tooltip（保留节点高亮，标识菜单对象）
            openContextMenu(pressPos.x, pressPos.y, id);
          }
        }, LONG_PRESS_MS);
        if (layoutMode === "2d") {
          drag.active = true;
          drag.button = 0;
          drag.startX = drag.lastX = e.clientX;
          drag.startY = drag.lastY = e.clientY;
          drag.moved = false;
          dragNodeId = pickNode(e.clientX, e.clientY); // 命中节点→拖节点；未命中→平移
        }
        // 3D：单指旋转交给 controls，这里只记录 downAt 供抬手择点
      } else if (touchPoints.size === 2) {
        // 双指→捏合缩放：停掉长按/单手拖拽/节点拖拽，避免手指漂移造成平移跳变；3D 恢复相机
        clearTimeout(pressTimer); pressActive = false;
        pinchActive = true;
        const p = [...touchPoints.values()];
        pinchDist = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
        drag.active = false;
        dragNodeId = null;
        _drag3d = null;
        controls.enabled = true;
        downAt.active = false;
        clearHoverAt();
      }
      return;
    }

    // ---------- 鼠标 / 触控笔：原逻辑 ----------
    downAt.x = e.clientX;
    downAt.y = e.clientY;
    downAt.button = e.button;
    downAt.active = true;
    if (layoutMode === "2d") {
      drag.active = true;
      drag.button = e.button;
      drag.startX = drag.lastX = e.clientX;
      drag.startY = drag.lastY = e.clientY;
      drag.moved = false;
      // 命中节点 → 进入"节点拖拽"（该节点位置跟鼠标走，力导仍跑）；未命中 → 视图平移
      dragNodeId = e.button === 0 ? pickNode(e.clientX, e.clientY) : null;
      el.setPointerCapture(e.pointerId);
    } else if (layoutMode === "3d" && e.button === 0) {
      // 3D 拖节点（对齐旧项目）：命中节点则建立"过节点、垂直于相机"的平面，拖拽期间暂停相机
      const id = pickNode(e.clientX, e.clientY);
      if (id != null) {
        dragNodeId = id;
        controls.enabled = false;
        const p = nodePos.get(id);
        _drag3d = { dir: new THREE.Vector3(), d: 0 };
        perspCamera.getWorldDirection(_drag3d.dir);
        _drag3d.d = -_drag3d.dir.dot(p);
        el.setPointerCapture(e.pointerId);
      }
    }
  });

  el.addEventListener("pointermove", (e) => {
    const isTouch = e.pointerType === "touch";
    if (isTouch && touchPoints.has(e.pointerId)) touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // 手指移动超过阈值 → 视为拖动，取消长按
    if (isTouch && pressActive && Math.hypot(e.clientX - pressPos.x, e.clientY - pressPos.y) > 8) {
      clearTimeout(pressTimer);
      pressActive = false;
    }
    // 触摸按压期间保持 hover：移动只让 tooltip 跟随手指（内容=按下时的节点），抬起才清除。
    // 这里绝不 hideTooltip/清 hoverId——否则"手指一动 hover 就没了"，与 up 才取消的语义相反。
    if (isTouch && touchPoints.size === 1 && hoverId != null) {
      showTooltipAt(e.clientX, e.clientY, nodeInfoHtml(hoverId));
    }

    // 触屏双指捏合缩放：2D 调 viewHeight；3D 由 ThreeDControls 内部处理，这里不干预
    if (isTouch && touchPoints.size >= 2 && pinchActive) {
      const p = [...touchPoints.values()];
      const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      if (pinchDist > 0 && layoutMode === "2d") {
        const ratio = d / pinchDist;
        viewHeight = THREE.MathUtils.clamp(viewHeight / ratio, ZOOM_H_MIN, ZOOM_H_MAX);
      }
      pinchDist = d;
      hideTooltip();
      return;
    }
    // 触屏 3D 单指：旋转/缩放交给 controls；tooltip 已在上面跟随手指，不隐藏
    if (isTouch && layoutMode === "3d") {
      return;
    }
    // 触屏 2D 单指：drag.* 已由 pointerdown 置好，走下方同一套平移/拖节点逻辑
    // 3D 拖节点：鼠标 ray 与"过节点、垂直于相机"的平面求交，把节点移到交点（旧项目同款）
    if (layoutMode === "3d" && dragNodeId != null && _drag3d) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const denom = _drag3d.dir.dot(raycaster.ray.direction);
      if (Math.abs(denom) > 1e-6) {
        const t = -(_drag3d.dir.dot(raycaster.ray.origin) + _drag3d.d) / denom;
        const hit = raycaster.ray.origin.clone().add(raycaster.ray.direction.clone().multiplyScalar(t));
        nodePos.get(dragNodeId).copy(hit);
      }
      return;
    }
    // 节点拖拽：被拖节点位置跟鼠标走（正交 2D：世界增量 = 屏幕增量 × 世界每像素；用相机真实世界轴）
    // 与视图平移方向相反：平移移动相机（-方向），节点移动跟随光标（+方向）
    if (layoutMode === "2d" && dragNodeId != null) {
      const dx = e.clientX - drag.lastX;
      const dy = e.clientY - drag.lastY;
      const v = nodePos.get(dragNodeId);
      if (v) {
        const me = orthoCamera.matrixWorld.elements;
        const rx = me[0], ry = me[1]; // right (X) 世界 xy
        const ux = me[4], uy = me[5]; // up   (Y) 世界 xy
        const worldPerPx = viewHeight / renderer.domElement.clientHeight;
        v.x += (rx * dx - ux * dy) * worldPerPx;
        v.y += (ry * dx - uy * dy) * worldPerPx;
      }
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      if (Math.abs(e.clientX - drag.startX) + Math.abs(e.clientY - drag.startY) > 3) drag.moved = true;
      if (!isTouch) hideTooltip(); // 触摸：拖动时也不取消 hover，tooltip 已跟随
      return;
    }
    if (layoutMode === "2d" && drag.active) {
      const dx = e.clientX - drag.lastX;
      const dy = e.clientY - drag.lastY;
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      if (Math.abs(e.clientX - drag.startX) + Math.abs(e.clientY - drag.startY) > 3) drag.moved = true;
      if (!isTouch) hideTooltip(); // 触摸：拖动时也不取消 hover，tooltip 已跟随
      if (drag.button === 0 || drag.button === 2) {
        // 平移（左/右键都平移，对齐旧项目；PointerEvent button: 0左 1中 2右）。
        // 用相机真实世界轴(right/up)平移：内容跟随光标。取 orthoCamera.matrixWorld 的 X/Y 列，
        // 与 rotateZ(viewRotZ) 的滚转严格一致，避免中键旋转后再拖方向不一致。
        const e = orthoCamera.matrixWorld.elements;
        const rx = e[0], ry = e[1]; // right (X) 世界 xy
        const ux = e[4], uy = e[5]; // up   (Y) 世界 xy
        const worldPerPx = viewHeight / renderer.domElement.clientHeight;
        viewTarget.x += (-rx * dx + ux * dy) * worldPerPx;
        viewTarget.y += (-ry * dx + uy * dy) * worldPerPx;
        if (layoutMode === "2d") viewTarget.z = 0;
      } else if (drag.button === 1) {
        // 绕 Z 旋转（中键，对齐旧项目）
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

  const endPointer = (e) => {
    const isTouch = e.pointerType === "touch";
    if (isTouch) {
      const wasSingle = touchPoints.size === 1;
      touchPoints.delete(e.pointerId);
      if (touchPoints.size < 2) pinchActive = false;
      // 取消长按 & 悬停（抬手即取消）
      clearTimeout(pressTimer);
      pressActive = false;
      clearHoverAt();
      // 2D 单手拖拽收尾 + 3D 节点拖拽收尾（恢复相机）
      if (layoutMode === "2d" && drag.active) drag.active = false;
      if (layoutMode === "3d" && dragNodeId != null) { _drag3d = null; controls.enabled = true; }
      dragNodeId = null;
      // 抬手择点（tap）：仅当没长按出菜单、且是一次完整单指、未拖动过多
      if (touchPoints.size === 0 && wasSingle && downAt.active && !longPressFired) {
        downAt.active = false;
        const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
        if (moved <= 10) {
          const id = pickNode(e.clientX, e.clientY);
          handleNodeClick(id, e); // 切换选中 / 双击聚焦 / 组合键；空点无操作
        }
      } else if (touchPoints.size === 0) {
        downAt.active = false;
      }
      return;
    }
    // ---------- 鼠标 / 触控笔：原逻辑 ----------
    if (layoutMode === "3d" && dragNodeId != null) { _drag3d = null; controls.enabled = true; }
    dragNodeId = null;
    if (layoutMode === "2d" && drag.active) {
      drag.active = false;
      if (drag.button === 0 && drag.moved) { /* 平移过，不作为点击 */ }
    }
    // 单击选中/组合键/空点在 2D 与 3D 都生效
    if (!downAt.active) return;
    downAt.active = false;
    if (e.button !== 0) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    if (moved > 5) return;
    const id = pickNode(e.clientX, e.clientY);
    handleNodeClick(id, e); // 切换选中 / 双击聚焦 / 组合键；空点无操作
  };
  el.addEventListener("pointerup", endPointer);
  el.addEventListener("pointercancel", endPointer);

  // 缩放（2D 正交）
  el.addEventListener("wheel", (e) => {
    if (layoutMode !== "2d") return;
    e.preventDefault();
    viewHeight *= 1 + e.deltaY * 0.0012;
    viewHeight = THREE.MathUtils.clamp(viewHeight, ZOOM_H_MIN, ZOOM_H_MAX);
  }, { passive: false });

  // 右键流光级联（shift+右键 = 反向流光，同旧项目）。
  // 触摸长按由上面的长按定时器统一处理；这里用 pressActive guard 拦截安卓 Chrome 在长按时
  // 自己触发的 contextmenu 事件（否则会跟定时器重复弹两次菜单）。鼠标右键不设 pressActive，走原逻辑。
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (pressActive) return;
    const id = pickNode(e.clientX, e.clientY);
    if (id) openContextMenu(e.clientX, e.clientY, id);
  });

  // 数字键 5-9（+单击 = 按跳数选邻居）；Ctrl+H 自动上色 / Ctrl+Shift+H 清除未选中节点颜色
  window.addEventListener("keydown", (e) => {
    if (isTypingTarget(e)) return;
    if (/^[5-9]$/.test(e.key)) keysHeld.add(e.key);
    if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "h") {
      e.preventDefault();
      enableFlowColor();
    } else if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === "h") {
      // Ctrl+Shift+H：清除未选中节点的颜色（对齐旧 clearSpecifiedColor；用 Shift 而非 Alt，Mac 通用）
      e.preventDefault();
      clearUnselectedColor();
    } else if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === "d") {
      // Ctrl+Shift+D：按维度着色边 / 关闭
      e.preventDefault();
      toggleDimEdges();
    } else if (e.key === ",") {
      // 沿入边方向(上游)逐跳选中；Ctrl+, 走到上游全部闭包
      e.preventDefault();
      selectAlongEdges(-1, e.ctrlKey);
    } else if (e.key === ".") {
      // 沿出边方向(下游)逐跳选中；Ctrl+. 走到下游全部闭包
      e.preventDefault();
      selectAlongEdges(1, e.ctrlKey);
    }
  });
  window.addEventListener("keyup", (e) => keysHeld.delete(e.key));
  window.addEventListener("blur", () => keysHeld.clear());

  initMenubar();
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

/** 写某条边的 flow 属性：起点侧=v、终点侧=v-1（对齐旧 FlowLine::onFlowChangedImpl）；v=-2 表示无流光。 */
function setEdgeFlow(idx, v) {
  if (!edgeGeo || !edgeGeo.attributes.edgeFlow) return;
  const o = idx * 4;
  eFlowArr[o + 0] = v;
  eFlowArr[o + 3] = v;
  eFlowArr[o + 1] = v - 1;
  eFlowArr[o + 2] = v - 1;
  edgeGeo.attributes.edgeFlow.needsUpdate = true;
}

let flowGestureEdges = new Set(); // 本次右键手势已流过的边索引：同一手势内不重播，保证一次性动画并防止选中子图有环时无限往返
/** 边流光脉冲：沿「该节点 → 选中邻居」的边传播，到达端点再级联（穿越选中子图）。
 *  对齐旧 FlowLine：每条边只脉冲一次(0→1)后熄灭；手势内已流过的边不再重复。 */
function startFlowFrom(id, backward = false) {
  const edges = state.edges;
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    // 对齐旧 startFlowFrom：正向只取「出边」(id→callee)，反向只取「入边」(caller→id)。
    // 带的方向由 animateFlowEdge 决定：正向 from→to，反向 to→from（反向时 0 带从 id 走向呼叫方）。
    let targetId = null;
    if (backward) {
      if (e.to === id && nodeIx.has(e.from)) targetId = e.from; // 入边 → 呼叫方(上游)
    } else {
      if (e.from === id && nodeIx.has(e.to)) targetId = e.to;   // 出边 → 被调用方(下游)
    }
    if (!targetId || targetId === id) continue;
    if (flowGestureEdges.has(i)) continue; // 本次手势已流，跳过（防环）
    flowGestureEdges.add(i);
    // 只有到达端点是「选中/高亮/组选」才继续级联；否则仅让这条边亮一次
    const cascade = selectedIds.has(targetId) || highlightIds.has(targetId);
    animateFlowEdge(i, targetId, cascade, backward);
  }
}

function animateFlowEdge(idx, targetId, cascade, backward) {
  // backward = 反向流光（shift+右键）
  const from = backward ? 1 : 0;
  const to = backward ? 0 : 1;
  setEdgeFlow(idx, from);
  tween.add({
    from, to, duration: 550, ease: sineInOut,
    onUpdate: (v) => {
      setEdgeFlow(idx, v);
    },
    onEnd: () => {
      setEdgeFlow(idx, -2);
      if (cascade) startFlowFrom(targetId, backward); // 级联到下一跳
    },
  });
}

// ---------- 节点右键浮动菜单 + 查看源码 ----------
const ctxMenu = document.getElementById("context-menu");
let ctxMenuNodeId = null;
function openContextMenu(clientX, clientY, nodeId) {
  ctxMenuNodeId = nodeId;
  ctxMenu.hidden = false;
  // 修正菜单位置，避免超出视口
  const r = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = Math.max(6, Math.min(clientX, window.innerWidth - r.width - 6)) + "px";
  ctxMenu.style.top = Math.max(6, Math.min(clientY, window.innerHeight - r.height - 6)) + "px";
}
function hideContextMenu() {
  ctxMenu.hidden = true;
  ctxMenuNodeId = null;
}
ctxMenu.addEventListener("click", (e) => {
  const act = (e.target.closest(".ctx-item") || {}).dataset?.act;
  const id = ctxMenuNodeId;
  hideContextMenu();
  if (!id || !act) return;
  if (act === "flow" || act === "flow-back") {
    flowGestureEdges.clear(); // 新手势：本次只做一回动画
    startFlowFrom(id, act === "flow-back");
  } else if (act === "source") {
    viewSourceForNode(id);
  } else if (act === "copy-hover") {
    // 复制 hover tooltip 内容（剥离 HTML 标签为纯文本）
    const html = nodeInfoHtml(id);
    const text = html ? html.replace(/<[^>]+>/g, "") : "";
    if (text) {
      navigator.clipboard?.writeText(text).then(
        () => toast(`已复制：${id}`),
        () => fallbackCopy(text),
      );
    }
  }
});
function toast(msg) {
  let t = document.getElementById("graph-toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "graph-toast";
    t.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:99;" +
      "background:rgba(22,27,34,.95);color:#e6edf3;border:1px solid #30363d;border-radius:6px;" +
      "padding:7px 12px;font:12px/1.4 system-ui,sans-serif;opacity:0;transition:opacity .2s;pointer-events:none;";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = "1";
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.style.opacity = "0"), 1600);
}
function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;left:-9999px";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); toast("已复制（兼容模式）"); } catch { toast("复制失败"); }
  document.body.removeChild(ta);
}
window.addEventListener("keydown", (e) => { if (e.key === "Escape") hideContextMenu(); });
document.addEventListener("pointerdown", (e) => { if (ctxMenu && !ctxMenu.contains(e.target)) hideContextMenu(); }, true);

/**
 * 从图节点定位并展示源码：查 /api/graph/source 拿到 file/line，
 * 打开左侧代码查看器 → openFile → 滚动并高亮到该行。无源码位置的节点给出提示。
 */
async function viewSourceForNode(id) {
  const project = projectSel.value;
  if (!project) { errorEl.textContent = "未选项目，无法查看源码"; return; }
  setCodePanel(true);
  // 优先用稳定 id（= Neo4j 的 id 属性，重索引后不失效）反查源码；node-<identity> 仅供旧逻辑兼容。
  const node = state.nodes.find((n) => n.id === id);
  const srcId = node && node.stableId ? node.stableId : id;
  const qs = new URLSearchParams({ project, id: srcId });
  try {
    const res = await fetch(`/api/graph/source?${qs}`);
    if (!res.ok) { const b = await res.text(); throw new Error(`${res.status}: ${b.slice(0, 160)}`); }
    const data = await res.json();
    if (!data || !data.file) {
      errorEl.textContent = `节点「${(data && (data.name || data.label)) || id}」没有可用的源码位置`;
      return;
    }
    // 让代码查看器的项目与图项目一致（不同才切换；切换会重置目录树）
    if (codeProjectSel.value !== project) {
      codeProjectSel.value = project;
      codeProjectSel.dispatchEvent(new Event("change"));
    }
    await openFile(data.file);
    if (data.line != null) locateCodeLine(data.line);
  } catch (err) {
    errorEl.textContent = `查看源码失败: ${err instanceof Error ? err.message : err}`;
  }
}

/** 在代码查看器里滚动到某行并加高亮。 */
function locateCodeLine(line) {
  const target = codeEl.querySelector(`.code-line[data-line="${line}"]`);
  if (!target) return;
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  target.classList.add("found");
}

// ---------- 场景初始化与主循环 ----------
function initThree() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a0f); // 对齐旧项目 (0.1,0.1,0.12)（无光照 unlit）

  const aspect0 = window.innerWidth / window.innerHeight;
  perspCamera = new THREE.PerspectiveCamera(60, aspect0, 0.001, 100000);
  perspCamera.position.set(0, 0, 60);
  orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e6, 1e6);
  camera = layoutMode === "2d" ? orthoCamera : perspCamera;

  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true /** DBG 屏幕像素回读 */ });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  app.appendChild(renderer.domElement);

  controls = new ThreeDControls(perspCamera, renderer.domElement);
  controls.enabled = false; // 默认 2D

  graphGroup = new THREE.Group();
  scene.add(graphGroup);

  setupInteraction();

  window.addEventListener("resize", () => {
    const w = window.innerWidth, h = window.innerHeight;
    perspCamera.aspect = w / h;
    perspCamera.updateProjectionMatrix();
    renderer.setSize(w, h); // ortho 的 left/right/top/bottom 每帧由 cameraForMode 按新窗口尺寸重算
  });

  lastTime = performance.now();
  animate();
}

let __frame = 0;
let __frameErrShown = false;
function animate(now) {
  requestAnimationFrame(animate);
  let dt = now - lastTime;
  lastTime = now;
  if (dt > 100) dt = 16;
  __frame++;

  try {
    tween.update(dt);
    if (layoutRunning && state.nodes.length) stepLayout(dt);
    densityTick++;
    if ((densityTick & 7) === 0) updateScaleByDistance();
    updateLabelPositions();
    applyHighlights();
    // 边：更新相机朝向 uniform（GPU 侧做 Billboard）+ 动态缓冲（跟随节点位移/颜色）
    updateEdgeBuffers();
    if (edgeMesh) {
      camera.getWorldDirection(_EDGE_CAMDIR);
      edgeMesh.material.uniforms.camDir.value.copy(_EDGE_CAMDIR);
    }
    cameraForMode();
    if (layoutMode === "3d") controls.update();
    // 缩放条反向同步：滚轮/平移导致实际缩放变化时，让拖拽条跟随（拖拽中不抢焦点）
    if (!zoomDragging) {
      const zv = layoutMode === "2d" ? zoomFromHeight(viewHeight) : zoomFromDist(camera.position.distanceTo(controls.target));
      if (+zoomEl.value !== zv) zoomEl.value = String(zv);
    }
    renderer.render(scene, camera); // 关键：渲染也包进 try，出错打日志不冻结画布
  } catch (err) {
    if (!__frameErrShown) {
      __frameErrShown = true;
      console.log("[DBG][FRAME-ERR] " + (err && err.stack ? err.stack : err));
    }
  }
}

// ---------- 数据接入（保留原接口） ----------
function clearGraph() {
  while (graphGroup.children.length) graphGroup.remove(graphGroup.children[0]);
  nodeMesh = null;
  instNode = [];
  nodeIx.clear();
  nodeScale.clear();
  nodeLabels.clear();
  nodesById.clear();
  nodePos.clear();
  dotNodes = new Set();
  nextAnchors = new Map();
  edgeMesh = null;
  edgeGeo = null;
  edgeData = [];
  ePosArr = eDirArr = eColArr = eUvArr = eFlowArr = null;
  state = { nodes: [], edges: [] };
  selectedIds = new Set();
  activeId = null;
  hoverId = null;
  highlightIds = new Set();
  if (historyCountEl) historyCountEl.textContent = "";
  if (historyRowsEl) historyRowsEl.innerHTML = "";
}

/** 把 data 并入当前图并补齐缺失对象/位置（增量，保留已有节点位置 → 供沉降动画）。 */
function renderGraph(data, seedId) {
  const isFresh = state.nodes.length === 0;
  mergeView(data);
  nodesById.clear();
  for (const n of state.nodes) nodesById.set(n.id, n);

  const seedPos = seedId ? nodePos.get(seedId) : null;
  for (const n of state.nodes) {
    if (nodePos.has(n.id)) continue;
    const p = new THREE.Vector3();
    if (seedPos) {
      p.copy(seedPos).add(new THREE.Vector3((Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10, 0));
    } else {
      p.set((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, layoutMode === "2d" ? 0 : (Math.random() - 0.5) * 10);
    }
    nodePos.set(n.id, p);
    nodeScale.set(n.id, 1);
  }
  rebuildNodes(); // 重建 InstancedMesh（节点数变化时）

  rebuildEdges();
  if (dotLayoutOn) computeDotLayout(); // NEXT 节点用 dot 分层布局并固定
  if (isFresh) centerView(); // 仅在全新加载时居中；增量并入（探索/定位）不跳相机
  statsEl.textContent = `${state.nodes.length} 节点 · ${state.edges.length} 边`;
  errorEl.textContent = "";
  renderResultRows(data.rows);
  renderSearchHistory(data.history); // 当前图的叠加搜索历史（随图切换）
  // 流色按"图"恢复/清空：同图重渲染恢复着色，换新图（节点集合变化）则清空，防止残留上一张图的颜色
  applyFlowForGraph();
  applyHighlights();
  applyDepthMode(); // 按 2D/3D 设深度遮挡：3D 用真实 z 遮挡，2D 靠绘制序
}

/** 深度遮挡模式：3D 启真实深度(节点/边/标签都按 z 遮挡)，2D 保持 transparent+depthTest:false 靠 renderOrder。 */
function applyDepthMode() {
  const d3 = layoutMode === "3d";
  if (nodeMesh && nodeMesh.material) {
    nodeMesh.material.depthTest = d3;
    nodeMesh.material.depthWrite = d3;
    nodeMesh.material.needsUpdate = true;
  }
  if (edgeMesh && edgeMesh.material) {
    edgeMesh.material.depthTest = d3; // 边真实深度：被前面节点正确地挡住
    edgeMesh.material.depthWrite = d3; // 边也写深度：在前的边能挡住后面的节点
    edgeMesh.material.needsUpdate = true;
  }
  for (const [, lab] of nodeLabels) { // 标签：3D 也被近节点遮挡(不再恒置顶)
    if (lab.material) lab.material.depthTest = d3;
  }
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

// ---------- 图搜索历史面板（叠加语句列表，可收起） ----------
/** 展示当前图的叠加搜索历史：每条为一次 query_graph/探索并入。空历史时收起并置灰标题。 */
function renderSearchHistory(history) {
  const list = Array.isArray(history) ? history : [];
  if (historyCountEl) historyCountEl.textContent = list.length ? `${list.length} 条叠加` : "";
  if (!historyRowsEl) return;
  historyRowsEl.innerHTML = "";
  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "暂无叠加搜索——当前图为空或尚未用 query_graph 查询";
    historyRowsEl.appendChild(empty);
    applyHistoryOpen(false); // 空历史时默认收起，避免占面板
    return;
  }
  for (let i = list.length - 1; i >= 0; i--) { // 最新的排最上
    const e = list[i];
    const row = document.createElement("div");
    row.className = "history-row";
    const top = document.createElement("span");
    top.className = "rev";
    top.textContent = `#${e.rev ?? i + 1}`;
    row.append(top);
    if (e.at) {
      const at = document.createElement("span");
      at.className = "at";
      at.textContent = formatHistoryTime(e.at);
      row.append(at);
    }
    if (e.name) {
      const nameEl = document.createElement("div");
      nameEl.className = "hname";
      nameEl.textContent = e.name;
      row.append(nameEl);
    }
    const cypher = document.createElement("code");
    cypher.className = "cypher";
    cypher.textContent = e.cypher || "(空查询)";
    cypher.title = "点击复制此搜索语句";
    cypher.addEventListener("click", (ev) => {
      ev.stopPropagation();
      navigator.clipboard?.writeText(cypher.textContent).then(() => toast("已复制该搜索语句")).catch(() => {});
    });
    row.append(cypher);
    if ((e.addedNodes != null && e.addedNodes > 0) || (e.addedEdges != null && e.addedEdges > 0)) {
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = `  +${e.addedNodes ?? 0}节点 +${e.addedEdges ?? 0}边`;
      row.append(meta);
    }
    historyRowsEl.appendChild(row);
  }
  applyHistoryOpen(historyOpen);
}

function formatHistoryTime(iso) {
  try {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  } catch { return ""; }
}

/** 应用折叠态：historyOpen=true 展开显示列表，false 收起。持久化到 localStorage。 */
function applyHistoryOpen(open) {
  historyOpen = !!open;
  if (historyRowsEl) historyRowsEl.hidden = !historyOpen;
  if (historyCaretEl) historyCaretEl.textContent = historyOpen ? "▾" : "▸";
  try { localStorage.setItem(HISTORY_OPEN_KEY, historyOpen ? "1" : "0"); } catch { /* 忽略 */ }
}

function initHistoryToggle() {
  try {
    const saved = localStorage.getItem(HISTORY_OPEN_KEY);
    if (saved === "0") historyOpen = false;
  } catch { historyOpen = true; }
  applyHistoryOpen(historyOpen);
  if (historyHeadEl) historyHeadEl.addEventListener("click", () => applyHistoryOpen(!historyOpen));
}

// ---------- 右侧整体面板收起/展开 ----------
const PANEL_COLLAPSE_KEY = "shishan-panel-collapsed";
let panelCollapsed = false;
/** 应用右侧面板折叠态：收起时 .panel 收窄到标题栏、隐藏 .panel-body，并持久化。 */
function applyPanelCollapsed(collapsed) {
  panelCollapsed = !!collapsed;
  const panel = document.getElementById("panel");
  if (panel) panel.classList.toggle("collapsed", panelCollapsed);
  const caret = document.getElementById("panel-caret");
  if (caret) caret.textContent = panelCollapsed ? "▸" : "▾";
  try { localStorage.setItem(PANEL_COLLAPSE_KEY, panelCollapsed ? "1" : "0"); } catch { /* 忽略 */ }
}
function initPanelToggle() {
  try {
    const saved = localStorage.getItem(PANEL_COLLAPSE_KEY);
    if (saved === "1") panelCollapsed = true;
  } catch { panelCollapsed = false; }
  applyPanelCollapsed(panelCollapsed);
  const head = document.getElementById("panel-head");
  if (head) head.addEventListener("click", () => applyPanelCollapsed(!panelCollapsed));
}

function selectionLabels() {
  if (selectedIds.size === 0) return "未选中节点";
  if (selectedIds.size === 1) {
    const id = activeId ?? selectedIds.values().next().value;
    return `已选中: ${(nodesById.get(id) || {}).label || id}`;
  }
  return `已选中 ${selectedIds.size} 个节点`;
}
function syncSelectionUI() {
  expandBtn.disabled = selectedIds.size === 0;
  selEl.textContent = selectionLabels();
  applyHighlights();
  dbgSelection("sync");
}

/* [DBG] 选中后读选中/未选中节点的实际渲染像素（亮暗对比） */
function dbgSelection(tag) {
  console.log(`[DBG] ${tag} selectedIds.size=${selectedIds.size} nodes=${instNode.length}`);
  if (state.nodes.length > 0) {
    const selId = activeId ?? selectedIds.values().next().value;
    const selNode = selId && nodePos.has(selId) ? selId : null;
    let unselId = null;
    for (const n of state.nodes) if (!selectedIds.has(n.id) && nodePos.has(n.id)) { unselId = n.id; break; }
    if (selNode) {
      const px = readNodePixel(selNode);
      if (px) console.log(`[DBG] renderedPixel(选中 ${selNode}) = [${px.join(",")}]`);
    }
    if (unselId) {
      const px = readNodePixel(unselId);
      if (px) console.log(`[DBG] renderedPixel(未选中 ${unselId}) = [${px.join(",")}]`);
    }
  }
}

/** [DBG] 直接读「屏幕画布」默认帧缓冲上某节点的实际像素（preserveDrawingBuffer） */
function readScreenPixel(id) {
  const p0 = nodePos.get(id);
  if (!nodePos.has(id)) return null;
  const W = renderer.domElement.width;
  const H = renderer.domElement.height;
  const p = p0.clone().project(camera);
  const sx0 = Math.floor((p.x * 0.5 + 0.5) * W);
  const sy0 = Math.floor((-p.y * 0.5 + 0.5) * H);
  const bx = Math.max(0, Math.min(W - 3, sx0 - 1));
  const by = Math.max(0, Math.min(H - 3, sy0 - 1));
  const gl = renderer.getContext();
  const buf = new Uint8Array(4 * 9);
  gl.readPixels(bx, H - by - 3, 3, 3, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  let best = [0, 0, 0, 0], bl = -1;
  for (let i = 0; i < 9; i++) {
    const r = buf[i * 4], g = buf[i * 4 + 1], b = buf[i * 4 + 2], a = buf[i * 4 + 3];
    if (r + g + b > bl) { bl = r + g + b; best = [r, g, b, a]; }
  }
  return best;
}

/** [DBG] 把场景渲到离屏纹理，在节点屏幕位置采 3x3 取最亮 RGBA（抗布局漂移误采） */
function readNodePixel(id) {
  const p0 = nodePos.get(id);
  if (!p0) return null;
  const W = renderer.domElement.width;
  const H = renderer.domElement.height;
  const rt = new THREE.WebGLRenderTarget(W, H);
  renderer.setRenderTarget(rt);
  renderer.render(scene, camera);
  const p = p0.clone().project(camera);
  let sx0 = Math.floor((p.x * 0.5 + 0.5) * W);
  let sy0 = Math.floor((-p.y * 0.5 + 0.5) * H);
  const buf = new Uint8Array(4 * 9);
  // 读 3x3 块（含目标点）
  const bx = Math.max(0, Math.min(W - 3, sx0 - 1));
  const by = Math.max(0, Math.min(H - 3, sy0 - 1));
  renderer.readRenderTargetPixels(rt, bx, H - by - 3, 3, 3, buf);
  renderer.setRenderTarget(null);
  rt.dispose();
  let best = [0, 0, 0, 0];
  let bestLum = -1;
  for (let i = 0; i < 9; i++) {
    const r = buf[i * 4], g = buf[i * 4 + 1], b = buf[i * 4 + 2], a = buf[i * 4 + 3];
    const lum = r + g + b;
    if (lum > bestLum) { bestLum = lum; best = [r, g, b, a]; }
  }
  return best;
  return Array.from(buf);
}
/** 清空并选中单个节点（聚焦/定位落点）。 */
function selectOnly(id) {
  selectedIds = new Set(id == null ? [] : [id]);
  activeId = id == null ? null : id;
  syncSelectionUI();
}
/** 追加单个节点进多选（定位结果点击行）。 */
function addSelect(id) {
  if (id == null) return;
  selectedIds.add(id);
  activeId = id;
  syncSelectionUI();
}
/**
 * 沿有向边方向逐跳扩展选中（对齐旧 BoundedIncrementalGraph::selectUpward/selectDownward）：
 *  dir<0（逗号 ,）：对每个已选节点，取所有入边(from→id)的源节点 from 并入选中 —— 沿入边方向(向上/上游)
 *  dir>0（句点 .）：对每个已选节点，取所有出边(id→to)的目标节点 to 并入选中 —— 沿出边方向(向下/下游)
 *  累积式（并集，不清空现有选中）；toClosure 时重复到不动点（对齐 Ctrl+,/Ctrl+. 全部闭包）。
 */
function selectAlongEdges(dir, toClosure) {
  let frontier = new Set(selectedIds);
  let guard = 0;
  for (;;) {
    const add = new Set();
    for (const id of frontier) {
      for (const e of state.edges) {
        if ((dir < 0 && e.to === id) || (dir > 0 && e.from === id)) add.add(dir < 0 ? e.from : e.to);
      }
    }
    let addedAny = false;
    for (const x of add) if (!selectedIds.has(x)) { selectedIds.add(x); addedAny = true; }
    if (!toClosure || !addedAny || add.size === 0) break;
    frontier = add;
    if (++guard > 100000) break;
  }
  if (activeId == null || !selectedIds.has(activeId)) activeId = selectedIds.values().next().value ?? null;
  syncSelectionUI();
  applyHighlights();
}
/** 切换单个节点的选中态（单击）。 */
function toggleSelect(id) {
  if (id == null) return;
  if (selectedIds.has(id)) {
    selectedIds.delete(id);
    if (activeId === id) activeId = selectedIds.values().next().value ?? null;
  } else {
    selectedIds.add(id);
    activeId = id;
  }
  syncSelectionUI();
}

async function expand() {
  if (!activeId) return;
  if (!selectedIds.has(activeId)) activeId = selectedIds.values().next().value ?? null;
  if (!activeId) return;
  errorEl.textContent = "";
  const project = projectSel.value;
  const dir = dirSel.value;
  // $id 匹配的是 Neo4j 的 id 属性（稳定 id）；activeId 是 node-<identity> 视图 id，需换成 stableId，
  // 否则重索引后（甚至任何视图下）都匹配不到节点，扩展一直为空。
  const node = state.nodes.find((n) => n.id === activeId);
  const matchId = node && node.stableId ? node.stableId : activeId;
  const cypher =
    `MATCH (a {id:$id})-[r:${dir}]-(b {projectId:$project}) ` +
    "RETURN a, r, b LIMIT 200";
  // 自动生成语义名（含节点 label 与方向）写入搜索历史；label 取节点展示名，缺失时退回其 id。
  const nodeLabel = node ? (node.label || node.name || matchId) : matchId;
  const searchName = `扩展 ${nodeLabel} 沿 ${dir}`;
  const url =
    `/api/graph/query?project=${encodeURIComponent(project)}` +
    `&cypher=${encodeURIComponent(cypher)}&id=${encodeURIComponent(matchId)}` +
    `&name=${encodeURIComponent(searchName)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${res.status}: ${body.slice(0, 200)}`);
    }
    const view = await res.json();
    renderGraph(view, activeId); // 增量并入，新节点在主选中节点附近生成并沉降
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
    // 跳过后端为"纯标量查询结果"捏的 Result 占位节点，不展示、不污染工作图
    if (n && n.kind === "Result") continue;
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

/** 带重试、且对非 JSON 响应（如部署空档 nginx 的 502 HTML 页）健壮的 JSON 拉取。
 *  成功返回解析后的对象；超过重试次数才抛错，由调用方决定自愈策略。 */
const MAX_FETCH_RETRY = 5;
async function fetchJson(url, retries = MAX_FETCH_RETRY) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("application/json") && !ct.includes("text/json")) {
        const sample = (await res.text()).slice(0, 80).replace(/\s+/g, " ");
        throw new Error(`非 JSON 响应 (${ct || "未知类型"}): ${sample}`);
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      // 指数退避：600ms / 1.2s / 1.8s …，趟过瞬时 502 / 后端重启空档
      await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw lastErr;
}

async function loadProjects() {
  try {
    const data = await fetchJson("/api/projects");
    projectSel.innerHTML = "";
    for (const p of data.projects || []) {
      const opt = document.createElement("option");
      opt.value = p.name;
      opt.textContent = p.name;
      projectSel.appendChild(opt);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errorEl.textContent = `加载项目失败（${msg}），5 秒后自动重试…`;
    setTimeout(loadProjects, 5000); // 自愈：后端恢复后自动重新加载
  }
}

async function loadViews() {
  const project = projectSel.value;
  if (!project) return;
  let data;
  try {
    data = await fetchJson(`/api/graph/views?project=${encodeURIComponent(project)}`);
  } catch {
    return; // 瞬时失败交给后台轮询下次再取，不必打断交互
  }
  viewSel.innerHTML = '<option value="">— 实时跟随当前工作图 —</option>';
  for (const v of data.views || []) {
    const opt = document.createElement("option");
    opt.value = v.id;
    // 有意义的名字优先（new_graph 命名的保存），否则退回 id；带节点数便于辨认
    const label = v.name && v.name !== v.id ? v.name : v.id;
    const size = typeof v.nodes === "number" ? ` · ${v.nodes}节点` : "";
    opt.textContent = `${label}${size}`;
    viewSel.appendChild(opt);
  }
}

/** [live] 固定页实时跟随当前工作图：agent 调 query_graph → 增量并入；new_graph → 保存并清空。
 * 仅当下拉框为空（实时跟随）时跟随；选中某个已保存视图（pin）时暂停，避免被拽走。 */
let lastGraphSig = "";
let lastLocateId = null; // 已处理过的待定位稳定 id，避免重复聚焦
async function pollCurrent() {
  const project = projectSel.value;
  if (!project) return;
  if (viewSel.value !== "") return; // 用户 pinned 了某个历史视图，不跟随
  try {
    const res = await fetch(`/api/graph/current?project=${encodeURIComponent(project)}`);
    if (!res.ok) return;
    const cur = await res.json();
    // 外部定位：/api/graph/locate 设置的稳定 id → 当前图里找到并选中+居中
    const loc = cur && cur.locateId;
    if (loc && loc !== lastLocateId) {
      lastLocateId = loc;
      const target = state.nodes.find((n) => n.stableId === loc);
      if (target) { selectedIds = new Set([target.id]); applyHighlights(); focusNode(target.id); toast("已定位节点"); }
      else toast("定位：该节点不在当前图中");
    }
    const nodes = (cur.nodes || []).length;
    const edges = (cur.edges || []).length;
    const sig = `${cur.revision || 0}:${nodes}:${edges}`;
    if (sig === lastGraphSig) return; // 无变化，跳过
    if (cur.empty || nodes === 0) {
      if (state.nodes.length > 0) {
        clearGraph();
        statsEl.textContent = "0 节点 · 0 边（工作图已清空，等待新的 query_graph）";
      }
      lastGraphSig = sig;
      return;
    }
    // 全新搜索替换：new_graph 清空+查询可能在一次轮询间隙内完成，页面没看到"空"中间态，
    // 若新图与当前渲染图毫无重叠则视为替换，先清空旧图再渲染（避免把新图并入旧图、旧节点残留颜色）。
    if (state.nodes.length > 0 && Array.isArray(cur.nodes)) {
      const curIds = new Set(cur.nodes.map((n) => n.id));
      const overlap = state.nodes.some((n) => curIds.has(n.id));
      if (!overlap) clearGraph();
    }
    renderGraph(cur); // 增量并入：按 id 去重、保留已有节点位置（沉降动画）
    // 关键：只有成功渲染后才提交 sig。若渲染抛异常被 catch 吞掉，sig 不提交，下轮会重试，
    // 避免卡在旧图、必须手动刷新。
    lastGraphSig = sig;
  } catch { /* 瞬时错误跳过，下次轮询再试 */ }
}
setInterval(pollCurrent, 2000);

async function load() {
  errorEl.textContent = "";
  const project = projectSel.value;
  if (!project) {
    errorEl.textContent = "请先选择项目";
    return;
  }
  let viewId = viewSel.value;
  if (viewId === "__current__") viewId = ""; // 兼容直达当前工作图的 URL
  if (!viewId) {
    // 实时跟随：直接读当前累积工作图（query_graph 增量并入的）
    const res = await fetch(`/api/graph/current?project=${encodeURIComponent(project)}`);
    if (!res.ok) {
      errorEl.textContent = `读取当前工作图失败: ${res.status}`;
      return;
    }
    const cur = await res.json();
    // 加载新内容 → 重置当前图
    clearGraph();
    if (cur.empty || !cur.nodes?.length) {
      statsEl.textContent = "0 节点 · 0 边（工作图为空，先让 AI 调用 query_graph，或手动 POST /api/run/query_graph）";
      return;
    }
    renderGraph(cur);
    return;
  }
  // 加载已保存视图 → 用该视图整图替换当前工作图（含其搜索历史），之后新查询在此图上继续叠加
  const restoreRes = await fetch(`/api/graph/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project, viewId }),
  });
  if (!restoreRes.ok) {
    errorEl.textContent = `加载视图失败: ${restoreRes.status}`;
    return;
  }
  await restoreRes.json();
  const curRes = await fetch(`/api/graph/current?project=${encodeURIComponent(project)}`);
  if (!curRes.ok) {
    errorEl.textContent = `读取替换后的当前工作图失败: ${curRes.status}`;
    return;
  }
  const cur = await curRes.json();
  clearGraph();
  if (cur.empty || !cur.nodes?.length) {
    statsEl.textContent = "该视图为空";
    renderSearchHistory(cur.history);
    return;
  }
  renderGraph(cur);
  toast("已用该视图替换当前工作图");
}

initHistoryToggle(); // 恢复搜索历史面板的收起/展开态
initPanelToggle();   // 恢复右侧整体面板的收起/展开态
initThree();
restoreViewToggles(); // 刷新后恢复流色/维度着色模式；换图/同图都会按当前图重算应用
document.getElementById("build").textContent = `build ${BUILD}`;

// [DBG] 自动自测：?autopick=1 时加载后自动停布局并选中第一个节点，触发像素对比日志
const __autopick = new URLSearchParams(location.search).has("autopick");
if (__autopick) {
  setTimeout(() => {
    if (instNode.length > 0) {
      layoutRunning = false;
      const first = state.nodes[0].id;
      selectOnly(first);
      setTimeout(() => {
        console.log(`[DBG] AUTOPICK done first=${first} nodes=${instNode.length} total=${state.nodes.length}`);
      }, 300);
    } else {
      setTimeout(() => console.log("[DBG] AUTOPICK no nodes yet"), 2000);
    }
  }, 4000);
}

// [DBG] 自动把 [DBG] 日志上报到后端 /api/graph/dbglog，方便读取排查
(() => {
  const _origLog = console.log;
  const _q = [];
  console.log = (...a) => {
    _origLog.apply(console, a);
    try {
      const s = a.map((x) => (x instanceof Error ? (x.message + " " + (x.stack || "")) : String(x))).join(" ");
      if (s.includes("[DBG]")) _q.push(s);
    } catch (e) { /* ignore */ }
  };
  setInterval(() => {
    if (!_q.length) return;
    const batch = _q.splice(0);
    fetch("/api/graph/dbglog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lines: batch }),
    }).catch(() => {});
  }, 2000);
})();

// ---------- 控件 ----------
modeBtn.addEventListener("click", () => {
  layoutMode = layoutMode === "2d" ? "3d" : "2d";
  controls.enabled = layoutMode === "3d";
  modeBtn.textContent = layoutMode === "2d" ? "切到 3D" : "切到 2D";
  if (layoutMode === "3d") {
    camera = perspCamera;
    controls.target.copy(viewTarget);
    perspCamera.position.set(viewTarget.x + 40, viewTarget.y + 20, viewTarget.z + 45);
    controls.update();
    // 三维展开：给节点加 Z 抖动，让布局离开 XY 平面
    for (const v of nodePos.values()) v.z += (Math.random() - 0.5) * 8;
  } else {
    camera = orthoCamera;
    viewTarget.set(controls.target.x, controls.target.y, 0);
    for (const v of nodePos.values()) v.z = 0;
  }
  applyDepthMode(); // 切换 2D/3D 时更新深度遮挡
  applyHighlights();
});

layoutBtn.addEventListener("click", () => {
  layoutRunning = !layoutRunning;
  layoutBtn.textContent = layoutRunning ? "暂停布局" : "继续布局";
});

// NEXT:DOT 开关：NEXT 连接节点用 dot 分层布局并固定，其余节点力导
const dotBtn = document.getElementById("dot-btn");
function toggleDotLayout() {
  dotLayoutOn = !dotLayoutOn;
  if (dotLayoutOn) {
    computeDotLayout();
  } else {
    dotNodes = new Set();
    // 解除固定的 dot 节点：给个随机扰动，让力导能重新摊开
    for (const nd of state.nodes) {
      const v = nodePos.get(nd.id);
      if (v) { v.x += (Math.random() - 0.5) * 6; v.y += (Math.random() - 0.5) * 6; }
    }
  }
  dotBtn.textContent = dotLayoutOn ? "NEXT:DOT 开" : "NEXT:DOT 关";
  persistViewToggles();
}
dotBtn.addEventListener("click", () => { closeAll(); toggleDotLayout(); });

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
    row.addEventListener("click", () => addSelect(m.id));
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
      selectOnly(data.matches[0].id);
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
  lastGraphSig = ""; // 换项目后重新跟随新项目的当前工作图
  syncScipSelector(projectSel.value);
  loadViews();
  resetCodeTree();
});
codeProjectSel.addEventListener("change", () => {
  projectSel.value = codeProjectSel.value;
  lastGraphSig = "";
  loadViews();
  resetCodeTree();
});
loadBtn.addEventListener("click", load);
expandBtn.addEventListener("click", expand);
resetBtn.addEventListener("click", () => {
  selectedIds = new Set();
  activeId = null;
  load();
});
