import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const app = document.getElementById("app");
const projectSel = document.getElementById("project");
const viewSel = document.getElementById("view");
const loadBtn = document.getElementById("view-btn");
const statsEl = document.getElementById("stats");
const errorEl = document.getElementById("error");
const selEl = document.getElementById("sel");
const dirSel = document.getElementById("dir");
const expandBtn = document.getElementById("expand-btn");
const resetBtn = document.getElementById("reset-btn");

let scene, camera, renderer, controls, graphGroup;
let nodeMeshes = new Map(); // node id -> THREE.Mesh
let nodesById = new Map(); // node id -> node
let selectedId = null;
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
  selectNode(selectedId);
}

function selectNode(id) {
  selectedId = id;
  expandBtn.disabled = !id;
  selEl.textContent = id ? `已选中: ${(nodesById.get(id) || {}).label || id}` : "未选中节点";
  for (const [nid, mesh] of nodeMeshes) {
    mesh.material.emissiveIntensity = nid === id ? 1.1 : 0.25;
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
loadProjects().then(() => {
  loadViews();
  // 从 query_graph 返回的 URL（http://localhost:18081/#/view/<project>/<viewId>）直达对应视图
  const m = location.hash.match(/^#\/view\/([^/]+)\/([^/]+)$/);
  if (m) {
    projectSel.value = decodeURIComponent(m[1]);
    loadViews();
    viewSel.value = decodeURIComponent(m[2]);
    load();
  }
});
projectSel.addEventListener("change", loadViews);
loadBtn.addEventListener("click", load);
expandBtn.addEventListener("click", expand);
resetBtn.addEventListener("click", () => {
  selectedId = null;
  load();
});