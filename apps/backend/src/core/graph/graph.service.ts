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
  ): Promise<QueryResult> {
    this.assertProject(project);
    const records = await this.neo4j.run(cypher, params, "read");
    const view = extractGraphView(cypher, records);
    const viewId = this.saveView(project, view, cypher);
    return {
      project,
      viewId,
      viewUrl: `${this.config.viewBaseUrl}/#/view/${project}/${viewId}`,
      nodes: view.nodes.length,
      edges: view.edges.length,
      view,
      cypher,
    };
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

  /** 取某个已保存的快照（供前端渲染）。 */
  loadView(project: string, viewId: string): (GraphView & { id: string; project: string; cypher: string }) | null {
    const file = viewPath(this.data.getRoot(), project, viewId);
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }

  listViews(project: string): Array<{ id: string; createdAt: string }> {
    const dir = path.join(this.data.getRoot(), "projects", project);
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          try {
            const raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as {
              id: string;
              createdAt: string;
            };
            return raw;
          } catch {
            return { id: f.replace(/\.json$/, ""), createdAt: "" };
          }
        })
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    } catch {
      return [];
    }
  }

  private saveView(project: string, view: GraphView, cypher: string): string {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const dir = path.join(this.data.getRoot(), "projects", project);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      viewPath(this.data.getRoot(), project, id),
      JSON.stringify(
        { id, project, cypher, createdAt: new Date().toISOString(), ...view },
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

  function addNode(id: string, label: string, kind: string) {
    if (nodeSeen.has(id)) return;
    nodeSeen.add(id);
    nodes.push({ id, label, kind });
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
      addNode(id, String(label), kind);
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