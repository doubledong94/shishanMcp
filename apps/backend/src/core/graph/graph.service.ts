import { Injectable, Logger } from "@nestjs/common";
import * as fs from "node:fs";
import * as path from "node:path";
import { CodeReaderService } from "../code-reader.service";
import { DataStoreService } from "../data-store.service";
import { GraphConfig } from "./graph-config";
import { ScipClientService } from "./scip-client.service";
import { Neo4jService } from "./neo4j.service";

export interface GenerateResult {
  project: string;
  jobId?: string;
  status: string;
  message: string;
  indexPath?: string;
  graph?: Record<string, number>;
}

export interface GraphNode {
  id: string;
  label: string;
  kind: string;
  /** 完整 SCIP 符号（函数/字段/变量的全名），供 hover 提示展示来源。 */
  symbol?: string;
  file?: string;
  line?: number;
  /** Value 节点的子类型（CALLED_PARAM/LOCAL_VAR/FIELD/RETURN/INDEX…），kind 固定为 "Value"。 */
  subkind?: string;
  /** 运行时读写节点：read / write。 */
  access?: string;
  /** 数据库稳定唯一标识（Neo4j 的 id 属性），可用 MATCH (n {id:<此值>}) 在后端定位。 */
  stableId?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  label: string;
}

export interface GraphView {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** 非图结构（纯标量）结果，逐行格式化，供图谱页展示真实值。 */
  rows?: string[];
}

/** 一次并入当前工作图的搜索记录。一张图（current / 快照）的 history = 它由哪些查询叠加而成。 */
export interface SearchEntry {
  /** 并入后 current 的 revision。 */
  rev: number;
  at: string;
  /** 实际执行的 cypher 语句。 */
  cypher: string;
  /** 若来自 query_graph 预置模板，记录模板名（无则缺省）。 */
  preset?: string;
  addedNodes?: number;
  addedEdges?: number;
}

/** 每张图持久化的 history 上限（超出丢弃最旧）。 */
const HISTORY_LIMIT = 100;

/** 光标符号反查的命中节点（运行时 / 非运行时通用）。line 已归一为 1-based。 */
export interface SymbolMatch {
  id: string;
  label: string;
  kind: string;
  name: string;
  line: number;
  /** SCIP 起始列（0-based），命中该标识符在行内的起始字符位。 */
  col: number;
  /** SCIP 结束列（0-based，开区间），命中该标识符在行内的结束字符位。 */
  colEnd: number;
  file: string;
  signature: string;
  symbol: string;
  /** 距离光标行的行差（绝对值），越小越可能精确命中。 */
  lineDelta: number;
}

export interface QueryResult {
  project: string;
  viewId: string;
  viewUrl: string;
  nodes: number;
  edges: number;
  view: GraphView;
  cypher: string;
  /** 增量并入后当前工作图（__current__）的累积状态。 */
  current?: {
    nodes: number;
    edges: number;
    addedNodes: number;
    addedEdges: number;
    revision: number;
    history: SearchEntry[];
  };
}

/**
 * 代码图谱编排：SCIP 精确符号图 → Neo4j 图数据库（scip-java fork 聚合期直写）。
 *
 * 两个工具方法（供 MCP 工具与 REST 复用）：
 *  - generateScipIndex: 调 scip 网关生成索引（fork 聚合期直写 Neo4j）
 *  - queryGraph: 执行 cypher，把路径图结果存快照、可被图谱页渲染
 */
@Injectable()
export class GraphService {
  private readonly logger = new Logger(GraphService.name);

  constructor(
    private readonly config: GraphConfig,
    private readonly scip: ScipClientService,
    private readonly neo4j: Neo4jService,
    private readonly reader: CodeReaderService,
    private readonly data: DataStoreService,
  ) {}

  // ---------- 工具 1：SCIP 索引 ----------

  async generateScipIndex(project: string, language: string): Promise<GenerateResult> {
    this.assertProject(project);
    const { jobId } = await this.scip.submit(project, language);
    const job = await this.scip.waitForJob(jobId);
    if (job.status === "failed") {
      throw new Error(`scip 索引失败：${job.error || "未知错误"}`);
    }
    // scip-java fork 聚合期会直写 Neo4j；这里回查统计，让 AI 拿到"索引即入库"的结果。
    let graph: Record<string, number> | undefined;
    try {
      graph = await this.neo4j.countProject(project);
    } catch {
      graph = undefined;
    }
    const graphNote =
      graph && Object.values(graph).some((n) => n > 0)
        ? ` 已直写入库：${formatCounts(graph)}`
        : " 未检测到图数据（请确认用 --scip-java fork 部署，索引即入库）";
    return {
      project,
      jobId,
      status: job.status,
      message: `已生成 index.scip（项目 ${project}）。${graphNote}`,
      indexPath: job.indexPath,
      graph,
    };
  }

  // ---------- 工具 2：查询并渲染 ----------

  async queryGraph(
    project: string,
    cypher: string,
    params: Record<string, unknown> = {},
    preset?: string,
  ): Promise<QueryResult> {
    this.assertProject(project);
    const records = await this.neo4j.run(cypher, params, "read");
    const view = extractGraphView(cypher, records);
    // 增量并入当前工作图：本次结果按节点 id / 边 key 去重累加（固定页实时跟随、new_graph 命名保存都基于它）。
    const { merged, addedNodes, addedEdges, revision, history } = this.mergeCurrent(
      project,
      view,
      cypher,
      preset,
    );
    // 单次查询快照也存"并入后 current 的完整 history"，restore 它即得正确历史起点。
    const viewId = this.saveView(project, view, cypher, history);
    return {
      project,
      viewId,
      viewUrl: `${this.config.viewBaseUrl}/#/view/${project}/${viewId}`,
      nodes: view.nodes.length,
      edges: view.edges.length,
      view,
      cypher,
      current: {
        nodes: merged.nodes.length,
        edges: merged.edges.length,
        addedNodes,
        addedEdges,
        revision,
        history,
      },
    };
  }

  // ---------- 当前工作图（增量并入 + 命名保存 / 开新图） ----------

  /** 每个项目一个"待定位的稳定 id"。AI 拿到用户复制的 id 后 POST 到这里，前端轮询到即选中居中。 */
  private locateId = new Map<string, string>();

  setLocate(project: string, id: string) {
    this.locateId.set(project, id);
  }

  /** 项目当前累积工作图（供固定 3D 页实时轮询跟随），附带可能的"待定位 id"。 */
  getCurrent(project: string) {
    const cur = this.readCurrent(project);
    const id = this.locateId.get(project);
    return id ? { ...cur, locateId: id } : cur;
  }

  /** 把一次查询的结果并入当前工作图（按 id/边键去重），返回合并后的图与增量统计；history 追加本次并截断。 */
  private mergeCurrent(
    project: string,
    view: GraphView,
    cypher: string,
    preset?: string,
  ): { merged: GraphView; addedNodes: number; addedEdges: number; revision: number; history: SearchEntry[] } {
    const cur = this.readCurrent(project);
    const merged = mergeGraphs(cur, view);
    const addedNodes = merged.nodes.length - cur.nodes.length;
    const addedEdges = merged.edges.length - cur.edges.length;
    const revision = cur.revision + 1;
    const entry: SearchEntry = {
      rev: revision,
      at: new Date().toISOString(),
      cypher,
      preset,
      addedNodes,
      addedEdges,
    };
    const history = [...cur.history, entry].slice(-HISTORY_LIMIT);
    this.writeCurrent(project, { ...merged }, revision, history);
    return { merged, addedNodes, addedEdges, revision, history };
  }

  /**
   * 命名保存当前工作图并开新图：把累积的旧图以 name 保存为一份历史快照（有意义的名字便于回看），
   * 然后清空工作图、开启一张新图。与 query_graph 的增量并入配合，agent 换分析主题时调用。
   */
  newGraph(project: string, name: string) {
    this.assertProject(project);
    const cur = this.readCurrent(project);
    const oldNodes = cur.nodes.length;
    const oldEdges = cur.edges.length;
    // 无内容可保存：幂等清空，返回 nothingToSave。
    if (oldNodes === 0 && oldEdges === 0 && (!cur.rows || cur.rows.length === 0)) {
      this.writeCurrent(project, { nodes: [], edges: [] }, cur.revision + 1, []);
      return { project, saved: null, cleared: true, clearedNodes: 0 };
    }
    const id = this.saveNamedView(project, cur, name.trim());
    this.writeCurrent(project, { nodes: [], edges: [] }, cur.revision + 1, []);
    return {
      project,
      saved: {
        id,
        name: name.trim() || id,
        nodes: oldNodes,
        edges: oldEdges,
        url: `${this.config.viewBaseUrl}/#/view/${project}/${id}`,
      },
      cleared: true,
      clearedNodes: oldNodes,
    };
  }

  /**
   * 用一份已保存视图整图替换当前工作图（不是叠加）：把快照的内容 + 它存下的 history 原样写入
   * `__current__.json`（丢弃原 current），替换后的 current 历史 = 该视图历史；此后新的查询从这
   * 张替换后的图上继续叠加（history 继续 append）。revision 在现有基础上 +1 作为新起点。
   */
  restoreViewAsCurrent(
    project: string,
    viewId: string,
  ): { ok: boolean; project: string; viewId: string; nodes: number; edges: number } {
    this.assertProject(project);
    const view = this.loadView(project, viewId);
    if (!view) {
      throw new Error(`视图不存在：${project}/${viewId}`);
    }
    const prev = this.readCurrent(project);
    const nodes = (view as { nodes?: GraphNode[] }).nodes || [];
    const edges = (view as { edges?: GraphEdge[] }).edges || [];
    const rows = (view as { rows?: string[] }).rows;
    const history = (view as { history?: SearchEntry[] }).history || [];
    this.writeCurrent(project, { nodes, edges, rows }, prev.revision + 1, history);
    return { ok: true, project, viewId, nodes: nodes.length, edges: edges.length };
  }

  /** 返回某项目当前工作图（或某快照）的叠加搜索历史：供 MCP 只读工具与前端冗余兜底直查。 */
  getGraphHistory(project: string, viewId?: string) {
    this.assertProject(project);
    if (viewId) {
      const view = this.loadView(project, viewId);
      if (!view) {
        throw new Error(`视图不存在：${project}/${viewId}`);
      }
      const v = view as { nodes?: GraphNode[]; edges?: GraphEdge[]; history?: SearchEntry[] };
      return {
        project,
        viewId,
        kind: "view",
        nodes: (v.nodes || []).length,
        edges: (v.edges || []).length,
        history: v.history || [],
      };
    }
    const cur = this.readCurrent(project);
    return {
      project,
      viewId: "__current__",
      kind: "current",
      nodes: cur.nodes.length,
      edges: cur.edges.length,
      revision: cur.revision,
      history: cur.history,
    };
  }

  /** 读当前工作图（__current__.json），不存在时返回空工作图。 */
  private readCurrent(project: string) {
    try {
      const raw = JSON.parse(fs.readFileSync(this.currentPath(project), "utf8"));
      const nodes = Array.isArray(raw.nodes) ? (raw.nodes as GraphNode[]) : [];
      const edges = Array.isArray(raw.edges) ? (raw.edges as GraphEdge[]) : [];
      return {
        id: "__current__",
        project,
        name: "当前工作图（实时）",
        kind: "current",
        nodes,
        edges,
        rows: raw.rows,
        cypher: raw.cypher || "",
        history: Array.isArray(raw.history) ? (raw.history as SearchEntry[]) : [],
        revision: Number(raw.revision) || 0,
        updatedAt: raw.updatedAt || "",
        empty: nodes.length === 0 && edges.length === 0 && !(Array.isArray(raw.rows) && raw.rows.length > 0),
      };
    } catch {
      return {
        id: "__current__",
        project,
        name: "当前工作图（实时）",
        kind: "current",
        nodes: [],
        edges: [],
        history: [],
        revision: 0,
        updatedAt: "",
        empty: true,
      };
    }
  }

  /** 写当前工作图（__current__.json）。history 显式传入（调用点决定 append/reset/带入），cypher 取最近一条历史或显式 cypher。 */
  private writeCurrent(
    project: string,
    view: GraphView & { cypher?: string },
    revision: number,
    history: SearchEntry[] = [],
  ): void {
    const dir = path.join(this.data.getRoot(), "projects", project);
    fs.mkdirSync(dir, { recursive: true });
    const prev = this.readCurrent(project);
    const lastCypher =
      view.cypher || (history.length ? history[history.length - 1].cypher : prev.cypher || "");
    fs.writeFileSync(
      this.currentPath(project),
      JSON.stringify(
        {
          id: "__current__",
          project,
          name: "当前工作图（实时）",
          kind: "current",
          cypher: lastCypher,
          history,
          createdAt: prev.updatedAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          revision,
          nodes: view.nodes || [],
          edges: view.edges || [],
          rows: view.rows,
        },
        null,
        2,
      ),
    );
  }

  /** 命名保存一份历史快照：id 由名字 slug + 短时间戳构成，快照内带可读 name 与当时 current 的 history。 */
  private saveNamedView(
    project: string,
    src: { nodes: GraphNode[]; edges: GraphEdge[]; rows?: string[]; cypher?: string; history?: SearchEntry[] },
    name: string,
  ): string {
    const id = `${toSlug(name) || "graph"}-${Date.now().toString(36)}`;
    const dir = path.join(this.data.getRoot(), "projects", project);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      viewPath(this.data.getRoot(), project, id),
      JSON.stringify(
        {
          id,
          project,
          name: name || id,
          kind: "saved",
          cypher: src.cypher || "",
          history: src.history || [],
          createdAt: new Date().toISOString(),
          nodes: src.nodes,
          edges: src.edges,
          rows: src.rows,
        },
        null,
        2,
      ),
    );
    return id;
  }

  private currentPath(project: string): string {
    return path.join(this.data.getRoot(), "projects", project, "__current__.json");
  }

  /**
   * 按「文件 + 行号 + 列 + 光标下的标识符」从 Neo4j 反查符号节点。
   * 前端行/列都是 1-based；Neo4j 里 SCIP 的 range 是 0-based，因此查询前统一转 0-based。
   * 只做精确命中（同文件 + 同 0-based 行 + 光标列在节点 col 之后），
   * 不命中就返回空；历史无列数据不再回退（重索引后全量带 col）。
   * 返回结构化命中列表（n 自身，不扩展邻居）与可合并进 3D 画布的 nodes 视图。
   */
  async findSymbol(
    project: string,
    file: string,
    line: number,
    name: string,
    col?: number,
  ): Promise<{ project: string; file: string; line: number; name: string; col?: number; matches: SymbolMatch[]; view: GraphView }> {
    this.assertProject(project);
    const line0 = line - 1; // 前端 1-based → Neo4j SCIP 0-based（^第1行=0）
    const col0 = col ? col - 1 : -1; // 1-based → 0-based，未传列时不做列过滤
    const nameClause = `(n.name = $name OR n.signature CONTAINS $name OR n.symbol CONTAINS $name)`;
    const fileClause = `(n.file = $file OR n.filePath = $file)`;
    const cypher =
      `MATCH (n {projectId:$project}) ` +
      `WHERE ${fileClause} ` +
      `AND n.line = $line0 ` +
      // 光标列必须落在节点起始列之后。不用 col < colEnd 做上界判断：多行 occurrence 的
      // endCharacter 属于结束行，可能比起始列小（col < colEnd 会误拒真命中）。
      `AND coalesce(n.col, -1) <= $col0 ` +
      `AND ${nameClause} ` +
      `RETURN n LIMIT 400`;
    const records = await this.neo4j.run(
      cypher,
      { project, file, line0, col0, name },
      "read",
    );
    const matches = extractMatches(records, line);
    return {
      project,
      file,
      line,
      name,
      col,
      matches,
      view: extractGraphView(cypher, records),
    };
  }

  /**
   * 由「图节点 id（node-<Neo4j 内部 identity>）」反查该节点对应源码符号的位置。
   * 前端节点 id = `node-${identity}`（extractGraphView 生成），借此解析出 Neo4j 内部 id，
   * 取回该符号的 file/line/col 等源码位置——供「从图节点定位并展示原文件」用。
   * 查询结果里的 line/col 是 SCIP 0-based，line 对外归一为 1-based。
   */
  async nodeSource(project: string, nodeId: string) {
    this.assertProject(project);
    // 前端可用两种 id：node-<Neo4j 内部 identity>（图节点 id）或稳定 id（Neo4j id 属性）。
    // 重索引后内部 identity 会全部改变，先按 identity 查，未命中则回退按稳定 id 反查，保证
    // 索引重建后"查看源码"仍能定位。
    const identity = Number(String(nodeId).replace(/^node-/, ""));
    let rec: { get: (k: string) => any } | undefined;
    if (Number.isInteger(identity)) {
      const records = (await this.neo4j.run(
        `MATCH (n) WHERE id(n) = $identity RETURN n LIMIT 1`,
        { identity },
        "read",
      )) as Array<{ get: (k: string) => any }>;
      rec = records[0];
    }
    if (!rec) {
      const records = (await this.neo4j.run(
        `MATCH (n) WHERE n.id = $nodeId RETURN n LIMIT 1`,
        { nodeId },
        "read",
      )) as Array<{ get: (k: string) => any }>;
      rec = records[0];
    }
    // 查不到(如索引重建后旧 identity 失效)返回明确的 JSON 对象而非空体/null，避免前端 json() 崩。
    if (!rec) return { project, id: nodeId, found: false };
    const n = rec.get("n");
    if (!n || typeof n !== "object") return { project, id: nodeId, found: false };
    const props = n.properties || {};
    const labels = n.labels || [];
    const file = String(props.file ?? props.filePath ?? "");
    const line = neo4jInteger(props.line) + 1; // 0-based → 1-based（与前端行高亮对齐）
    return {
      project,
      id: `node-${n.identity.toString()}`,
      label: (labels[0] as string) || undefined,
      kind: props.kind != null ? String(props.kind) : undefined,
      name: props.name != null ? String(props.name) : undefined,
      file: file || undefined,
      line: props.line != null ? line : undefined,
      col: neo4jInteger(props.col),
      colEnd: neo4jInteger(props.colEnd),
      signature: props.signature != null ? String(props.signature) : undefined,
      symbol: props.symbol != null ? String(props.symbol) : undefined,
    };
  }

  /** 取某个已保存的快照（供前端渲染）。 */
  loadView(
    project: string,
    viewId: string,
  ): (GraphView & { id: string; project: string; cypher: string; history?: SearchEntry[] }) | null {
    const file = viewPath(this.data.getRoot(), project, viewId);
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }

  listViews(project: string): Array<{
    id: string;
    name?: string;
    kind?: string;
    createdAt: string;
    nodes?: number;
    edges?: number;
  }> {
    const dir = path.join(this.data.getRoot(), "projects", project);
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".json") && f !== "__current__.json")
        .map((f) => {
          try {
            const raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as {
              id: string;
              name?: string;
              kind?: string;
              createdAt: string;
              nodes?: unknown;
              edges?: unknown;
            };
            return {
              id: raw.id || f.replace(/\.json$/, ""),
              name: typeof raw.name === "string" && raw.name ? raw.name : undefined,
              kind: raw.kind,
              createdAt: raw.createdAt || "",
              nodes: Array.isArray(raw.nodes) ? raw.nodes.length : undefined,
              edges: Array.isArray(raw.edges) ? raw.edges.length : undefined,
            };
          } catch {
            const id = f.replace(/\.json$/, "");
            return { id, name: undefined, kind: undefined, createdAt: "", nodes: undefined, edges: undefined };
          }
        })
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    } catch {
      return [];
    }
  }

  private saveView(project: string, view: GraphView, cypher: string, history: SearchEntry[] = []): string {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const dir = path.join(this.data.getRoot(), "projects", project);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      viewPath(this.data.getRoot(), project, id),
      JSON.stringify(
        { id, project, cypher, history, createdAt: new Date().toISOString(), ...view },
        null,
        2,
      ),
    );
    return id;
  }

  private assertProject(project: string): void {
    if (!/^[\w.-]+$/.test(project)) {
      throw new Error(`project 参数非法（只允许字母数字、点、横线、下划线）：${project}`);
    }
    const proj = this.reader.resolveProject(project);
    if (!proj || !fs.existsSync(proj) || !fs.statSync(proj).isDirectory()) {
      throw new Error(`项目不存在：${project}`);
    }
  }
}

// ---------- 辅助函数 ----------

function viewPath(dataRoot: string, project: string, viewId: string): string {
  return path.join(dataRoot, "projects", project, `${viewId}.json`);
}

/** 合并两幅图：按节点 id、边 key（from->to->label）去重求并集，rows 取最新的。 */
function mergeGraphs(a: { nodes: GraphNode[]; edges: GraphEdge[]; rows?: string[] }, b: { nodes: GraphNode[]; edges: GraphEdge[]; rows?: string[] }): GraphView {
  const nodes = [...(a.nodes || [])];
  const edges = [...(a.edges || [])];
  const nodeSeen = new Set(nodes.map((n) => n.id));
  const edgeSeen = new Set(edges.map((e) => `${e.from}->${e.to}->${e.label}`));
  for (const n of b.nodes || []) {
    if (!nodeSeen.has(n.id)) {
      nodeSeen.add(n.id);
      nodes.push(n);
    }
  }
  for (const e of b.edges || []) {
    const key = `${e.from}->${e.to}->${e.label}`;
    if (!edgeSeen.has(key)) {
      edgeSeen.add(key);
      edges.push(e);
    }
  }
  return { nodes, edges, rows: (b.rows?.length ? b.rows : a.rows) };
}

/** 把名字转成 URL/文件名安全的 ASCII slug（非字母数字段折叠成 -，纯中文归为 ""）。 */
function toSlug(s: string): string {
  return (s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function formatCounts(graph: Record<string, number>): string {
  return Object.entries(graph)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${label}=${n}`)
    .join(" ");
}

// ---------- 查询结果 → 可渲染图 ----------

/**
 * 从 findSymbol 的 records 里抽出命中节点列表（n 变量），按与光标行的行差排序。
 * Neo4j 的 line/col 是 SCIP 0-based；对前端只暴露 line 的 1-based 换算（行高亮/展示用），
 * col/colEnd 保留 0-based 原始值（标识符在行内的起止字符位，供调试展示）。
 */
function extractMatches(records: unknown[], cursorLine: number): SymbolMatch[] {
  const out: SymbolMatch[] = [];
  const seen = new Set<string>();
  for (const rec of records as Array<{ get: (k: string) => any }>) {
    const n = rec.get("n");
    if (!n || typeof n !== "object") continue;
    const id = `node-${n.identity.toString()}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const props = n.properties || {};
    const labels = n.labels || [];
    const line = neo4jInteger(props.line) + 1; // 0-based → 1-based（与前端/dist DOM 对齐）
    out.push({
      id,
      label: (labels[0] as string) || "Node",
      kind: String(props.kind ?? ""),
      name: String(props.name ?? ""),
      line,
      col: neo4jInteger(props.col),
      colEnd: neo4jInteger(props.colEnd),
      file: String(props.file ?? props.filePath ?? ""),
      signature: String(props.signature ?? ""),
      symbol: String(props.symbol ?? ""),
      lineDelta: Math.abs(line - cursorLine),
    });
  }
  out.sort((a, b) => a.lineDelta - b.lineDelta);
  return out.filter((m) => m.label !== "Result");
}

/** neo4j-driver 的整数可能是 Long，统一转成 number。 */
function neo4jInteger(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof (v as any).toNumber === "function") return Number((v as any).toNumber());
  return Number(v) || 0;
}

/** 把 neo4j 返回的记录里的 Node/Relationship/Path 抽取成 nodes/edges。 */
function isNeo4jNode(v: Record<string, any>): boolean {
  return typeof v === "object" && v !== null && Array.isArray(v.labels) && "properties" in v;
}

function isNeo4jRel(v: Record<string, any>): boolean {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.type === "string" &&
    typeof v.start === "object" &&
    typeof v.end === "object" &&
    !Array.isArray(v.labels)
  );
}

function isNeo4jPath(v: Record<string, any>): boolean {
  return typeof v === "object" && v !== null && Array.isArray(v.segments);
}

function extractGraphView(cypher: string, records: unknown[]): GraphView {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const rows: string[] = [];
  const nodeSeen = new Set<string>();
  const edgeSeen = new Set<string>();

  function addNode(id: string, label: string, kind: string, extra?: { symbol?: string; file?: string; line?: number; subkind?: string; access?: string }) {
    if (nodeSeen.has(id)) return;
    nodeSeen.add(id);
    nodes.push({ id, label, kind, ...(extra || {}) });
  }
  function addEdge(from: string, to: string, label: string) {
    const key = `${from}->${to}->${label}`;
    if (edgeSeen.has(key)) return;
    edgeSeen.add(key);
    edges.push({ from, to, label });
  }

  function visit(value: unknown) {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const v of value) visit(v);
      return;
    }
    // neo4j-driver v5 返回的是普通对象：Node / Relationship / Path
    const v = value as Record<string, any>;
    if (isNeo4jNode(v)) {
      const id = `node-${v.identity.toString()}`;
      const labels = v.labels || [];
      const props = v.properties || {};
      const kind = labels[0] || "Node";
      const label = props.name || props.path || props.signature || props.kind || labels[0] || id;
      const extra = {
        ...(props.symbol ? { symbol: String(props.symbol) } : {}),
        ...(props.file ? { file: String(props.file) } : {}),
        ...(typeof props.line === "number" ? { line: props.line } : {}),
        ...(props.kind && kind === "Value" ? { subkind: String(props.kind) } : {}),
        ...(props.access ? { access: String(props.access) } : {}),
        ...(props.id ? { stableId: String(props.id) } : {}),
      };
      addNode(id, String(label), kind, extra);
      return;
    }
    if (isNeo4jRel(v)) {
      addEdge(
        `node-${v.start.toString()}`,
        `node-${v.end.toString()}`,
        String(v.type || "RELATED"),
      );
      return;
    }
    if (isNeo4jPath(v)) {
      for (const seg of v.segments || []) {
        visit(seg.start);
        visit(seg.end);
        addEdge(
          `node-${seg.start.identity.toString()}`,
          `node-${seg.end.identity.toString()}`,
          String(seg.relationship?.type || "RELATED"),
        );
      }
      return;
    }
  }

  for (const rec of records as Array<{ keys: string[]; get: (k: string) => unknown }>) {
    for (const key of rec.keys) {
      const raw = rec.get(key);
      if (isScalar(raw)) {
        rows.push(`${key}: ${scalarText(raw)}`);
      } else {
        visit(raw);
      }
    }
  }

  if (nodes.length === 0) {
    // 纯标量结果：把第一个结果作为说明节点标签，让 3D 页显示真实值
    addNode(
      "result",
      rows.length === 1 ? rows[0] : rows.length > 1 ? `查询结果（${rows.length} 行）` : "查询结果",
      "Result",
    );
  }
  return { nodes, edges, rows };
}

/** 标量值（string/number/boolean/null、neo4j 数值类型等），不是 Node/Rel/Path。 */
function isScalar(v: unknown): boolean {
  if (v == null) return true;
  if (Array.isArray(v)) return v.every(isScalar);
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return true;
  if (t === "object") {
    const o = v as Record<string, any>;
    return !Array.isArray(o.labels) && !Array.isArray(o.segments) && typeof o.type !== "string";
  }
  return true;
}

function scalarText(v: unknown): string {
  if (v == null) return String(v);
  if (Array.isArray(v)) return v.map((x) => scalarText(x)).join(", ");
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof (v as any)?.toNumber === "function") return String((v as any).toNumber());
  if (typeof (v as any)?.toString === "function") return (v as any).toString();
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}