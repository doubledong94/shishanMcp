import { BadRequestException, Controller, Delete, Get, NotFoundException, Param, Post, Query, Body } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { CallLogService } from "../core/call-log.service";
import { DataStoreService } from "../core/data-store.service";
import { CodeReaderService } from "../core/code-reader.service";
import { ProjectFileService } from "../core/project-file.service";
import { GraphService } from "../core/graph/graph.service";
import { ScipIndexViewerService } from "../core/graph/scip-index-viewer.service";
import { TOOL_REGISTRY } from "../tools/registry";
import { describeAllTools } from "../tools";

/**
 * REST surface for the web pages (proxied by nginx as /api in Docker).
 *
 * - /api/health -> server / MCP status
 * - /api/tools  -> every tool definition exactly as MCP sends it to the AI
 * - /api/calls  -> tool-call log (recorded from the MCP layer, source: "mcp")
 *
 * When you add more MCP tools, add a matching /api/run/:tool endpoint that
 * calls the SAME business logic, so the web console can exercise them
 * too (recorded with source: "rest").
 */
@Controller("api")
export class ApiController {
  constructor(
    private readonly calls: CallLogService,
    private readonly data: DataStoreService,
    private readonly reader: CodeReaderService,
    private readonly files: ProjectFileService,
    private readonly graph: GraphService,
    private readonly scipViewer: ScipIndexViewerService,
    private readonly moduleRef: ModuleRef,
  ) {}

  @Get("health")
  health() {
    return {
      status: "ok",
      server: process.env.MCP_SERVER_NAME || "shishan-mcp-server",
      version: process.env.MCP_SERVER_VERSION || "0.1.0",
      mcp: { transport: "streamable-http", endpoint: "/" },
      tools: describeAllTools().map((t) => t.name),
    };
  }

  @Get("tools")
  getTools() {
    return { tools: describeAllTools() };
  }

  /** Manually invoke any registered MCP tool from the debug console. */
  @Post("run/:tool")
  async runTool(@Param("tool") name: string, @Body() body: unknown) {
    const reg = TOOL_REGISTRY.find((t) => t.spec.name === name);
    if (!reg) {
      throw new NotFoundException(`工具不存在: ${name}`);
    }
    const instance = this.moduleRef.get(reg.cls, { strict: false }) as {
      run(input: unknown): unknown;
    };
    try {
      return await this.calls.track(name, "rest", body, () => instance.run(body));
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : String(err));
    }
  }

  @Get("calls")
  getCalls(@Query("limit") limit?: string) {
    const n = Number(limit ?? 100);
    return this.calls.list(Number.isFinite(n) ? n : 100);
  }

  @Delete("calls")
  clearCalls() {
    const cleared = this.calls.clear();
    return { cleared };
  }

  @Get("data")
  getDataInfo() {
    return {
      root: this.data.getRoot(),
      writable: this.data.isWritable(),
    };
  }

  @Get("projects")
  getProjects() {
    return {
      projects: this.reader.listProjects(),
    };
  }

  /** 某项目某目录下的条目（供图谱页代码查看器的目录树；默认隐藏重型目录）。 */
  @Get("projects/:project/entries")
  getProjectEntries(@Param("project") project: string, @Query("path") p?: string) {
    return { project, dir: p || "", entries: this.files.entries(project, p || "") };
  }

  /** 读取某项目内的一个文本文件（供图谱页代码查看器）。 */
  @Get("projects/:project/file")
  getProjectFile(@Param("project") project: string, @Query("path") p?: string) {
    if (!p) {
      throw new BadRequestException("缺少 path 参数（项目内相对路径）");
    }
    const file = this.files.read(project, p);
    if (!file) {
      throw new NotFoundException(`文件不存在或不可读: ${p}`);
    }
    return file;
  }

  /**
   * 按「文件 + 行号 + 列 + 光标下标识符」反查 Neo4j 符号节点（运行时的
   * CalledMethod/Value/Condition 与非运时的 Class/Method/Field/Value 一起返回），
   * 附带一张可合并进 3D 画布的 nodes 视图。
   */
  // [DBG] 前端自动上报的调试日志（环形缓冲，供排查"选中无视觉变化"）
  private dbgLog: string[] = [];

  @Post("graph/dbglog")
  dbglogPost(@Body() body: { lines?: string[] }) {
    const lines = body?.lines;
    if (Array.isArray(lines)) {
      for (const l of lines) if (typeof l === "string") this.dbgLog.push(l);
      if (this.dbgLog.length > 1000) this.dbgLog.splice(0, this.dbgLog.length - 1000);
    }
    return { ok: true, stored: this.dbgLog.length };
  }

  @Get("graph/dbglog")
  dbglogGet() {
    return { stored: this.dbgLog.length, lines: this.dbgLog };
  }

  @Get("graph/symbol")
  async getGraphSymbol(
    @Query("project") project?: string,
    @Query("file") file?: string,
    @Query("line") line?: string,
    @Query("name") name?: string,
    @Query("col") col?: string,
  ) {
    if (!project || !file) {
      throw new BadRequestException("需要 project 和 file 参数");
    }
    const lineNum = Number(line);
    if (!line || !Number.isInteger(lineNum) || lineNum < 1 || !name?.trim()) {
      throw new BadRequestException("需要合法的 line 和 name 参数（光标所在行号与标识符）");
    }
    const colNum = col ? Number(col) : undefined;
    if (col !== undefined && (!Number.isInteger(colNum) || (colNum as number) < 1)) {
      throw new BadRequestException("col 参数必须是正整数（1-based 列号）");
    }
    return this.graph.findSymbol(project, file, lineNum, name.trim().slice(0, 200), colNum);
  }

  /** 某项目的图视图快照列表（供 :18081 图谱页选择）。 */
  @Get("graph/views")
  getGraphViews(@Query("project") project?: string) {
    if (!project) return { views: [] };
    return { project, views: this.graph.listViews(project) };
  }

  /** SCIP 索引概览（元信息 + 文档列表统计，供调试页查看器）。 */
  @Get("scip-index/:project/summary")
  async getScipSummary(@Param("project") project: string) {
    this.scipViewer.assertMounted(project);
    return this.scipViewer.summary(project);
  }

  /** SCIP 索引单个文档内容（symbols + occurrences）。 */
  @Get("scip-index/:project/document")
  async getScipDocument(
    @Param("project") project: string,
    @Query("path") relativePath?: string,
  ) {
    this.scipViewer.assertMounted(project);
    if (!relativePath) {
      throw new BadRequestException("缺少 path 参数（文档相对路径）");
    }
    return this.scipViewer.document(project, relativePath);
  }

  /** 加载某个图视图快照（供 Three.js 渲染）。 */
  @Get("graph/views/:project/:viewId")
  getGraphView(@Param("project") project: string, @Param("viewId") viewId: string) {
    const view = this.graph.loadView(project, viewId);
    if (!view) {
      throw new NotFoundException(`视图不存在: ${project}/${viewId}`);
    }
    return view;
  }

  /**
   * 直接对 Neo4j 执行一条 cypher，返回可渲染的 {nodes, edges}（探索模式用）。
   * 与 query_graph 相同的业务逻辑；快照照常保存（探索的每一步都可回看）。
   */
  @Get("graph/query")
  async runGraphQuery(
    @Query("project") project?: string,
    @Query("cypher") cypher?: string,
    @Query("id") id?: string,
  ) {
    if (!project || !cypher) {
      throw new BadRequestException("需要 project 和 cypher 参数");
    }
    const params: Record<string, unknown> = { project };
    if (id != null) params.id = id;
    const result = await this.graph.queryGraph(project, cypher, params);
    return result.view;
  }
}
