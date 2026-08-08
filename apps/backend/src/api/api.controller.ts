import { BadRequestException, Controller, Delete, Get, NotFoundException, Param, Post, Query, Body } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { CallLogService } from "../core/call-log.service";
import { DataStoreService } from "../core/data-store.service";
import { CodeReaderService } from "../core/code-reader.service";
import { GraphService } from "../core/graph/graph.service";
import { ScipIndexViewerService } from "../core/graph/scip-index-viewer.service";
import { AstViewerService } from "../core/graph/ast-viewer.service";
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
    private readonly graph: GraphService,
    private readonly scipViewer: ScipIndexViewerService,
    private readonly astViewer: AstViewerService,
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

  /** 语法树文件列表 + 语言统计（供调试页语法树查看器）。 */
  @Get("ast/:project/summary")
  async getAstSummary(@Param("project") project: string) {
    this.astViewer.assertMounted(project);
    return this.astViewer.summary(project);
  }

  /** 读取单个语法树文件（AST 节点树）。 */
  @Get("ast/:project/tree")
  async getAstTree(
    @Param("project") project: string,
    @Query("ast") astPath?: string,
  ) {
    this.astViewer.assertMounted(project);
    if (!astPath) {
      throw new BadRequestException("缺少 ast 参数（ast 文件相对路径）");
    }
    return this.astViewer.tree(project, astPath);
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
}
