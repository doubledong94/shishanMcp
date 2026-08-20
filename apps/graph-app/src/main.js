import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

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

let scene, camera, renderer, controls, graphGroup;
let nodeMeshes = new Map(); // node id -> THREE.Mesh
let nodesById = new Map(); // node id -> node
let selectedId = null;
let highlightIds = new Set(); // 定位 Neo4j 节点时的命中高亮
let state = { nodes: [], edges: [] };

function initThree() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1117);

  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 5000);
  camera.position.set(40, 30, 40);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  app.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(30, 50, 30);
  scene.add(dir);

  graphGroup = new THREE.Group();
  scene.add(graphGroup);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  renderer.domElement.addEventListener("pointerdown", (e) => {
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(graphGroup.children, false);
    const hit = hits.find((h) => h.object.userData && h.object.userData.nodeId);
    selectNode(hit ? hit.object.userData.nodeId : null);
  });

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  animate();
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

const COLOR_BY_KIND = {
  Symbol: 0x238636,
  File: 0x58a6ff,
  Project: 0xe3b341,
  Result: 0xff7b72,
};

function nodeColor(kind) {
  return COLOR_BY_KIND[kind] ?? 0x8b949e;
}

/** 力导向式布局：给每个节点一个 3D 位置（简单斥力 + 弹簧）。 */
function layout(nodes, edges) {
  const pos = new Map();
  for (const n of nodes) pos.set(n.id, new THREE.Vector3((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30));

  for (let iter = 0; iter < 80; iter++) {
    // 斥力（所有节点之间）
    const arr = nodes.map((n) => pos.get(n.id));
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const d = arr[i].clone().sub(arr[j]);
        const dist = Math.max(d.length(), 1.2);
        const force = d.normalize().multiplyScalar(2.5 / (dist * dist));
        arr[i].add(force);
        arr[j].sub(force);
      }
    }
    // 弹簧（边）
    for (const e of edges) {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) continue;
      const d = b.clone().sub(a);
      const target = e.label === "REFERENCES" ? 6 : 3;
      const force = d.sub(d.normalize().multiplyScalar(target)).multiplyScalar(0.02);
      a.add(force);
      b.sub(force);
    }
    // 居中
    const centroid = new THREE.Vector3();
    arr.forEach((v) => centroid.add(v));
    centroid.divideScalar(Math.max(arr.length, 1));
    arr.forEach((v) => v.sub(centroid.clone().multiplyScalar(0.05)));
  }
  return pos;
}

function renderGraph(data) {
  state = data;
  while (graphGroup.children.length) graphGroup.remove(graphGroup.children[0]);
  const nodes = data.nodes || [];
  const edges = data.edges || [];
  nodeMeshes.clear();
  nodesById.clear();

  const pos = layout(nodes, edges);

  for (const n of nodes) {
    const v = pos.get(n.id) ?? new THREE.Vector3();
    const color = nodeColor(n.kind);
    const isRoot = n.kind === "Project" || n.kind === "Result";
    const geo = isRoot ? new THREE.SphereGeometry(1.6, 24, 24) : new THREE.SphereGeometry(0.9, 20, 20);
    const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.25 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(v);
    mesh.userData.nodeId = n.id;
    graphGroup.add(mesh);
    nodeMeshes.set(n.id, mesh);
    nodesById.set(n.id, n);

    // 标签
    const label = makeLabel(n.label, color);
    label.position.copy(v).add(new THREE.Vector3(0, 1.4, 0));
    graphGroup.add(label);
  }

  for (const e of edges) {
    const a = nodeMeshes.get(e.from);
    const b = nodeMeshes.get(e.to);
    if (!a || !b) continue;
    const mat = new THREE.LineBasicMaterial({
      color: 0x6e7681,
      transparent: true,
      opacity: 0.5,
    });
    const geo = new THREE.BufferGeometry().setFromPoints([a.position, b.position]);
    graphGroup.add(new THREE.Line(geo, mat));
  }

  // 居中相机
  if (nodes.length) {
    const center = new THREE.Vector3();
    let count = 0;
    for (const v of pos.values()) {
      center.add(v);
      count++;
    }
    if (count) center.divideScalar(count);
    controls.target.copy(center);
    camera.position.copy(center).add(new THREE.Vector3(25, 20, 25));
  }

  statsEl.textContent = `${nodes.length} 节点 · ${edges.length} 边`;
  errorEl.textContent = "";
  renderResultRows(data.rows);
  selectNode(selectedId);
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

/** 高亮状态统一应用：选中的 + 已定位的节点亮起，其余恢复。 */
function applyHighlights() {
  for (const [nid, mesh] of nodeMeshes) {
    mesh.material.emissiveIntensity = nid === selectedId || highlightIds.has(nid) ? 1.1 : 0.25;
  }
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
    mergeView(view);
    renderGraph(state);
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

function makeLabel(text, color) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.font = "28px system-ui, sans-serif";
  ctx.fillStyle = "#e6edf3";
  ctx.textBaseline = "middle";
  ctx.fillText(text.length > 18 ? text.slice(0, 18) + "…" : text, 8, 32);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(4, 1, 1);
  return sprite;
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
  const viewRes = await fetch(`/api/graph/views/${encodeURIComponent(project)}/${encodeURIComponent(viewId)}`);
  if (!viewRes.ok) {
    errorEl.textContent = `加载视图失败: ${viewRes.status}`;
    return;
  }
  const data = await viewRes.json();
  renderGraph(data);
}

initThree();

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
    mergeView(data.view);
    renderGraph(state);
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