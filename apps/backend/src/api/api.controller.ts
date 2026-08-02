import { BadRequestException, Controller, Delete, Get, NotFoundException, Param, Post, Query, Body } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { CallLogService } from "../core/call-log.service";
import { ToolService } from "../core/tool-service";
import { DataStoreService } from "../core/data-store.service";
import { CodeReaderService } from "../core/code-reader.service";
import { TOOL_REGISTRY } from "../tools/registry";
import { describeAllTools } from "../tools";

/**
 * REST surface for the web pages (proxied by nginx as /api in Docker).
 *
 * - /api/health -> server / MCP status
 * - /api/tools  -> every tool definition exactly as MCP sends it to the AI
 * - /api/calls  -> tool-call log (recorded from the MCP layer, source: "mcp")
 * - /api/code   -> the last file the AI's read_file read (shown on :8081)
 *
 * When you add more MCP tools, add a matching /api/run/:tool endpoint that
 * calls the SAME ToolService methods, so the web console can exercise them
 * too (recorded with source: "rest").
 */
@Controller("api")
export class ApiController {
  constructor(
    private readonly calls: CallLogService,
    private readonly tools: ToolService,
    private readonly data: DataStoreService,
    private readonly reader: CodeReaderService,
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

  @Get("code")
  getDisplayedFile() {
    const file = this.tools.getDisplayedFile();
    return file ? { file } : { file: null };
  }

  @Get("data")
  getDataInfo() {
    return {
      root: this.data.getRoot(),
      hostRoot: this.data.getHostRoot(),
      writable: this.data.isWritable(),
    };
  }

  @Get("projects")
  getProjects() {
    return {
      root: this.reader.getRoot(),
      hostRoot: this.reader.getHostRoot(),
      projects: this.reader.listProjects(),
    };
  }
}
