import { Injectable, Logger } from "@nestjs/common";
import * as fs from "node:fs";
import * as path from "node:path";
import { CodeReaderService } from "../code-reader.service";
import { DataStoreService } from "../data-store.service";
import { GraphConfig } from "./graph-config";
import { ScipClientService, ScipIndexJson } from "./scip-client.service";
import { Neo4jService } from "./neo4j.service";

export interface GenerateResult {
  project: string;
  jobId?: string;
  status: string;
  message: string;
  indexPath?: string;
}

export interface ImportResult {
  project: string;
  files: number;
  symbols: number;
  references: number;
  statements: number;
  message: string;
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
 * 代码图谱编排：SCIP 精确符号图 → Neo4j 图数据库。
 *
 * 三个工具方法（供 MCP 工具与 REST 复用）：
 *  - generateScipIndex: 调 scip 网关生成 index.scip
 *  - importGraph: 把 index.scip 写入 Neo4j
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
    return {
      project,
      jobId,
      status: job.status,
      message: `已生成 index.scip（项目 ${project}）`,
      indexPath: job.indexPath,
    };
  }

  // ---------- 工具 2：导入图数据 ----------

  async importGraph(project: string): Promise<ImportResult> {
    this.assertProject(project);
    await this.neo4j.ensureSchema();

    let scipIndex: ScipIndexJson | null = null;
    try {
      scipIndex = await this.scip.getIndexJson(project);
    } catch (err) {
      this.logger.warn(
        `读取 scip 索引失败，跳过符号图：${err instanceof Error ? err.message : err}`,
      );
    }

    const statements = buildImportStatements(project, scipIndex);
    await this.neo4j.runAll(statements);

    const counts = countImport(scipIndex);
    return {
      project,
      ...counts,
      statements: statements.length,
      message: `已将项目 ${project} 导入图数据库（${statements.length} 条写入语句）`,
    };
  }

  // ---------- 工具 2：查询并渲染 ----------

  async queryGraph(project: string, cypher: string): Promise<QueryResult> {
    this.assertProject(project);
    const records = await this.neo4j.run(cypher, {}, "read");
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

// ---------- 导入语句构造 ----------

/**
 * 把 SCIP 符号图转成一批参数化 cypher 语句（批量 UNWIND）。
 *
 * 图模型：
 *   (:Project)-[:CONTAINS]->(:File)
 *   (:File)-[:HAS_SYMBOL]->(:Symbol)           // 该文件定义的符号
 *   (:Symbol)-[:REFERENCES]->(:Symbol)         // 跨文件引用
 */
function buildImportStatements(
  project: string,
  scip: ScipIndexJson | null,
): Array<{ query: string; params: Record<string, unknown> }> {
  const out: Array<{ query: string; params: Record<string, unknown> }> = [];

  out.push({
    query: "MERGE (p:Project {id:$id}) SET p.name=$name, p.updatedAt=$updatedAt",
    params: { id: project, name: project, updatedAt: new Date().toISOString() },
  });

  // ---- SCIP 符号子图 ----
  if (scip?.documents && scip.documents.length > 0) {
    const symbols: Array<Record<string, unknown>> = [];
    const refEdges: Array<{ from: string; to: string }> = [];
    const symDefMap = new Map<string, { file: string; start: number; end: number }>();

    for (const doc of scip.documents) {
      for (const occ of doc.occurrences || []) {
        const isDef = (occ.symbol_roles || 0) & 1;
        const [start, end] = occ.range || [0, 0];
        if (isDef) {
          symbols.push({
            id: scipSymbolId(project, occ.symbol),
            name: shortSymbol(occ.symbol),
            signature: occ.symbol,
            filePath: doc.relative_path,
            start,
            end,
          });
          symDefMap.set(occ.symbol, { file: doc.relative_path, start, end });
        }
      }
    }

    // 引用：同一符号名被定义过才算边（去重）
    for (const doc of scip.documents) {
      for (const occ of doc.occurrences || []) {
        const isDef = (occ.symbol_roles || 0) & 1;
        if (isDef) continue;
        if (!symDefMap.has(occ.symbol)) continue;
        const from = scipSymbolId(project, `${occ.symbol}@${doc.relative_path}:${occ.range?.[0] ?? 0}`);
        const to = scipSymbolId(project, occ.symbol);
        refEdges.push({ from, to });
        symbols.push({
          id: from,
          name: shortSymbol(occ.symbol),
          signature: occ.symbol,
          filePath: doc.relative_path,
          start: occ.range?.[0] ?? 0,
          end: occ.range?.[1] ?? 0,
        });
      }
    }

    if (symbols.length > 0) {
      out.push({
        query: `
          UNWIND $symbols AS s
          MERGE (sym:Symbol {id:s.id})
          SET sym.name=s.name, sym.signature=s.signature,
              sym.start=s.start, sym.end=s.end,
              sym.filePath=s.filePath, sym.projectId=$projectId
          WITH sym, s
          MATCH (file:File {projectId:$projectId, path:s.filePath})
          MERGE (file)-[:HAS_SYMBOL]->(sym)`,
        params: { projectId: project, symbols },
      });
    }

    if (refEdges.length > 0) {
      out.push({
        query: `
          UNWIND $edges AS e
          MATCH (a:Symbol {id:e.from})
          MATCH (b:Symbol {id:e.to})
          MERGE (a)-[:REFERENCES]->(b)`,
        params: { edges: refEdges },
      });
    }
  }

  return out;
}

function scipSymbolId(project: string, symbol: string): string {
  return `scip:${project}:${symbol}`;
}

function shortSymbol(symbol: string): string {
  // scip 符号形如 "scip-python python module pkg.py -1/hello (name:8:2) /hello/name"
  const m = symbol.match(/[ /]+([\w.]+)\s*\(/);
  return m ? m[1] : symbol;
}

function countImport(scip: ScipIndexJson | null): { files: number; symbols: number; references: number } {
  const syms = new Set<string>();
  let refs = 0;
  for (const doc of scip?.documents || []) {
    for (const occ of doc.occurrences || []) {
      if ((occ.symbol_roles || 0) & 1) syms.add(occ.symbol);
      else refs++;
    }
  }
  return { files: scip?.documents?.length ?? 0, symbols: syms.size, references: refs };
}

// ---------- 查询结果 → 可渲染图 ----------

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
      visit(rec.get(key));
    }
  }

  if (nodes.length === 0) {
    // 纯标量结果，包成一个说明节点
    addNode("result", "查询结果", "Result");
  }
  return { nodes, edges };
}