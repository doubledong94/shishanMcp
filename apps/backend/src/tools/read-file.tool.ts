import { Injectable } from "@nestjs/common";
import { Tool } from "@rekog/mcp-nest";
import { z } from "zod";
import { ToolService } from "../core/tool-service";
import { CallLogService } from "../core/call-log.service";
import { ToolSpec } from "./tool-spec";
import { registerTool } from "./registry";

/** The full definition the AI sees for read_file. */
export const ReadFileToolSpec: ToolSpec = {
  name: "read_file",
  description:
    "读取 MCP 挂载的多个项目中某个文件的完整内容，不做分页，并展示到 MCP 功能页（:8081）。" +
    "path 必须是该文件在宿主机上的绝对路径（如 /Users/me/proj-a/src/main.py），MCP 会把它自动映射到容器内对应项目；" +
    "不支持相对路径。AI 只需要传绝对路径，内容由 MCP 直接从磁盘读取，无需复述。",
  parameters: z.object({
    path: z
      .string()
      .describe(
        "该文件在宿主机上的绝对路径，如 /Users/me/proj-a/src/main.py（必填，不支持相对路径）",
      ),
    filename: z
      .string()
      .optional()
      .describe("展示用的文件名，缺省取 path 的文件名"),
    language: z
      .string()
      .optional()
      .describe("展示用的语言名，缺省按扩展名推断"),
  }),
};

@Injectable()
export class ReadFileTool {
  constructor(
    private readonly tools: ToolService,
    private readonly calls: CallLogService,
  ) {}

  @Tool({
    name: ReadFileToolSpec.name,
    description: ReadFileToolSpec.description,
    parameters: ReadFileToolSpec.parameters,
  })
  async run(input: { path: string; filename?: string; language?: string }) {
    return this.calls.track("read_file", "mcp", input, () => this.tools.readFile(input));
  }
}

registerTool({ cls: ReadFileTool, spec: ReadFileToolSpec });
