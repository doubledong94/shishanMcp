import { Injectable, Logger } from "@nestjs/common";
import * as fs from "node:fs";
import * as path from "node:path";
import { CodeReaderService } from "../code-reader.service";
import { DataStoreService } from "../data-store.service";
import { GraphConfig } from "./graph-config";
import { ScipClientService, ScipIndexJson } from "./scip-client.service";
import { TreeSitterService, FileAst, AstNode } from "./tree-sitter.service";
import { Neo4jService } from "./neo4j.service";

export interface GenerateResult {
  project: string;
  jobId?: string;
  status: string;
  message: string;
  indexPath?: string;
}

export interface ViewTreeResult {
  project: string;
  language: string;
  files: number;
  failed: number;
  astPath: string;
}

export interface ImportResult {
  project: string;
  files: number;
  symbols: number;
  references: number;
  syntaxNodes: number;
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
 * 代码图谱编排：SCIP 精确符号图 + tree-sitter 语法树 → Neo4j 图数据库。
 *
 * 四个工具方法（供 MCP 工具与 REST 复用）：
 *  - generateScipIndex: 调 scip 网关生成 index.scip
 *  - generateSyntaxTree: 用 tree-sitter 解析项目生成语法树 JSON
 *  - importGraph: 合并 index.scip + 语法树写入 Neo4j
 *  - queryGraph: 执行 cypher，把路径图结果存快照、可被图谱页渲染
 */
@Injectable()
export class GraphService {
  private readonly logger = new Logger(GraphService.name);

  constructor(
    private readonly config: GraphConfig,
    private readonly scip: ScipClientService,
    private readonly ts: TreeSitterService,
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

  // ---------- 工具 2：语法树 ----------

  generateSyntaxTree(project: string, language?: string[]): ViewTreeResult {
    this.assertProject(project);
    const projRoot = this.reader.resolveProject(project)!;
    const files = collectSourceFiles(projRoot);
    const astDir = path.join(this.data.getRoot(), "ast", project);
    fs.mkdirSync(astDir, { recursive: true });

    const wanted = language ? new Set(language) : null;

    let ok = 0;
    let failed = 0;
    const languages = new Set<string>();

    for (const file of files) {
      const rel = path.relative(projRoot, file);
      // 先按文件扩展名/文件名自动判断语言（tree-sitter-language-pack）
      const lang = TreeSitterService.languageForPath(rel);
      if (!lang) continue;
      // language 列表作为过滤条件：未指定则全部语言
      if (wanted && !wanted.has(lang)) continue;
      try {
        const code = fs.readFileSync(file, "utf8");
        const parsed = this.ts.parse(code, lang, rel);
        languages.add(lang);
        const out = astFilePath(astDir, rel);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, JSON.stringify(parsed));
        ok++;
      } catch (err) {
        failed++;
        this.logger.warn(`tree-sitter 解析失败 ${rel}: ${err instanceof Error ? err.message : err}`);
      }
    }

    return {
      project,
      language: language?.join(",") || [...languages].join(","),
      files: ok,
      failed,
      astPath: astDir,
    };
  }

  // ---------- 工具 3：导入图数据 ----------

  async importGraph(project: string): Promise<ImportResult> {
    this.assertProject(project);
    await this.neo4j.ensureSchema();

    let scipIndex: ScipIndexJson | null = null;
    try {
      scipIndex = await this.scip.getIndexJson(project);
    } catch (err) {
      this.logger.warn(
        `读取 scip 索引失败，跳过符号图（只有语法树子图）：${err instanceof Error ? err.message : err}`,
      );
    }

    const astDir = path.join(this.data.getRoot(), "ast", project);
    const asts = fs.existsSync(astDir) ? readAstFiles(astDir) : [];

    const statements = buildImportStatements(project, asts, scipIndex);
    await this.neo4j.runAll(statements);

    const counts = countImport(asts, scipIndex);
    return {
      project,
      ...counts,
      statements: statements.length,
      message: `已将项目 ${project} 导入图数据库（${statements.length} 条写入语句）`,
    };
  }

  // ---------- 工具 4：查询并渲染 ----------

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

function astFilePath(astDir: string, rel: string): string {
  const withoutExt = rel.replace(/\.[^/\\]+$/, "");
  return path.join(astDir, withoutExt + ".ast.json");
}

function viewPath(dataRoot: string, project: string, viewId: string): string {
  return path.join(dataRoot, "projects", project, `${viewId}.json`);
}

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".cache",
  ".idea",
  ".vscode",
]);

function collectSourceFiles(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      if (IGNORED_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile()) {
        if (TreeSitterService.languageForPath(e.name)) out.push(full);
      }
    }
  }
  walk(root);
  return out;
}

function readAstFiles(astDir: string): FileAst[] {
  const out: FileAst[] = [];
  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".ast.json")) {
        try {
          out.push(JSON.parse(fs.readFileSync(full, "utf8")) as FileAst);
        } catch {
          /* skip corrupt */
        }
      }
    }
  }
  walk(astDir);
  return out;
}

// ---------- 导入语句构造 ----------

/**
 * 把语法树 + SCIP 符号图转成一批参数化 cypher 语句（批量 UNWIND）。
 *
 * 图模型：
 *   (:Project)-[:CONTAINS]->(:File)
 *   (:File)-[:HAS_AST]->(:SyntaxNode)          // 语法树根
 *   (:SyntaxNode)-[:CHILD]->(:SyntaxNode)      // 树父子
 *   (:File)-[:HAS_SYMBOL]->(:Symbol)           // 该文件定义的符号
 *   (:Symbol)-[:DECLARED_AT]->(:SyntaxNode)    // 按字节区间关联到语法树
 *   (:Symbol)-[:REFERENCES]->(:Symbol)         // 跨文件引用
 */
function buildImportStatements(
  project: string,
  asts: FileAst[],
  scip: ScipIndexJson | null,
): Array<{ query: string; params: Record<string, unknown> }> {
  const out: Array<{ query: string; params: Record<string, unknown> }> = [];

  out.push({
    query: "MERGE (p:Project {id:$id}) SET p.name=$name, p.updatedAt=$updatedAt",
    params: { id: project, name: project, updatedAt: new Date().toISOString() },
  });

  // ---- 语法树子图 ----
  const astFiles: Array<{ path: string; language: string }> = [];
  const astNodes: Array<Record<string, unknown>> = [];
  const astChildEdges: Array<{ from: string; to: string }> = [];
  const astRoots: Array<{ filePath: string; rootId: string }> = [];

  for (const file of asts) {
    astFiles.push({ path: file.path, language: file.language });
    flattenAst(file.path, file.nodes, astNodes, astChildEdges, astRoots);
  }

  out.push({
    query: `
      UNWIND $files AS f
      MERGE (file:File {projectId:$projectId, path:f.path})
      SET file.language = f.language
      WITH file
      MATCH (p:Project {id:$projectId})
      MERGE (p)-[:CONTAINS]->(file)`,
    params: { projectId: project, files: astFiles },
  });

  if (astNodes.length > 0) {
    out.push({
      query: `
        UNWIND $nodes AS n
        MERGE (s:SyntaxNode {id:n.id})
        SET s.kind=n.kind, s.name=n.name, s.start=n.start, s.end=n.end,
            s.filePath=n.filePath, s.projectId=$projectId
        WITH s, n
        MATCH (file:File {projectId:$projectId, path:n.filePath})
        MERGE (s)-[:BELONGS_TO]->(file)`,
      params: { projectId: project, nodes: astNodes },
    });
    out.push({
      query: `
        UNWIND $edges AS e
        MATCH (a:SyntaxNode {id:e.from})
        MATCH (b:SyntaxNode {id:e.to})
        MERGE (a)-[:CHILD]->(b)`,
      params: { edges: astChildEdges },
    });
    out.push({
      query: `
        UNWIND $roots AS r
        MATCH (file:File {projectId:$projectId, path:r.filePath})
        MATCH (root:SyntaxNode {id:r.rootId})
        MERGE (file)-[:HAS_AST]->(root)`,
      params: { projectId: project, roots: astRoots },
    });
  }

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
        const target = symDefMap.get(occ.symbol)!;
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
          MERGE (file)-[:HAS_SYMBOL]->(sym)
          WITH sym, s
          MATCH (sn:SyntaxNode {projectId:$projectId, filePath:s.filePath})
          WHERE sn.start <= s.start AND sn.end >= s.end
          WITH sym, s, sn ORDER BY (sn.end - sn.start) ASC
          WITH sym, s, head(collect(sn)) AS best
          FOREACH (x IN CASE WHEN best IS NULL THEN [] ELSE [1] END |
            MERGE (sym)-[:DECLARED_AT]->(best))`,
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

function flattenAst(
  filePath: string,
  nodes: AstNode[],
  outNodes: Array<Record<string, unknown>>,
  outEdges: Array<{ from: string; to: string }>,
  outRoots: Array<{ filePath: string; rootId: string }>,
): void {
  function walk(node: AstNode, parentId: string | null): string {
    const id = `${filePath}#${node.kind}:${node.start}:${node.end}`;
    outNodes.push({
      id,
      kind: node.kind,
      name: node.name ?? null,
      start: node.start,
      end: node.end,
      filePath,
    });
    if (parentId) outEdges.push({ from: parentId, to: id });
    for (const child of node.children) walk(child, id);
    return id;
  }
  for (const root of nodes) {
    const rootId = walk(root, null);
    outRoots.push({ filePath, rootId });
  }
}

function scipSymbolId(project: string, symbol: string): string {
  return `scip:${project}:${symbol}`;
}

function shortSymbol(symbol: string): string {
  // scip 符号形如 "scip-python python module pkg.py -1/hello (name:8:2) /hello/name"
  const m = symbol.match(/[ /]+([\w.]+)\s*\(/);
  return m ? m[1] : symbol;
}

function countImport(
  asts: FileAst[],
  scip: ScipIndexJson | null,
): { files: number; symbols: number; references: number; syntaxNodes: number } {
  let syntaxNodes = 0;
  for (const file of asts) syntaxNodes += countAstNodes(file.nodes);
  const syms = new Set<string>();
  let refs = 0;
  for (const doc of scip?.documents || []) {
    for (const occ of doc.occurrences || []) {
      if ((occ.symbol_roles || 0) & 1) syms.add(occ.symbol);
      else refs++;
    }
  }
  return { files: asts.length, symbols: syms.size, references: refs, syntaxNodes };
}

function countAstNodes(nodes: AstNode[]): number {
  let n = nodes.length;
  for (const node of nodes) n += countAstNodes(node.children);
  return n;
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