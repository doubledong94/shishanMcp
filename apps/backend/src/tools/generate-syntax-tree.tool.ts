import { Injectable } from "@nestjs/common";
import { Tool } from "@rekog/mcp-nest";
import { z } from "zod";
import { GraphService } from "../core/graph/graph.service";
import { CallLogService } from "../core/call-log.service";
import { ToolSpec } from "./tool-spec";
import { registerTool } from "./registry";
import { mountedProjectList, mountedProjectsHint } from "./mounted-projects";

export const GenerateSyntaxTreeToolSpec: ToolSpec = {
  name: "generate_syntax_tree",
  description:
    "对某个已挂载的项目用 tree-sitter-language-pack（306 语言）生成语法树，" +
    "结果 JSON 落盘到数据目录。之后可用 import_to_graph 导入图数据库。" +
    "当前已挂载项目：" + mountedProjectList(),
  parameters: z.object({
    project: z
      .string()
      .describe(
        "项目名（同路径挂载项目（绝对路径）的目录名）。" + mountedProjectsHint(),
      ),
    language: z
      .array(z.string())
      .optional()
      .describe(
        "tree-sitter 语言名数组（如 [\"python\", \"typescript\"]）。缺省=全部语言。" +
          "遍历项目文件时先按文件扩展名/文件名判断语言（tree-sitter-language-pack 自动识别），" +
          "只有判断出的语言在本列表中（或缺省）的文件才会被解析",
      ),
  }),
};

@Injectable()
export class GenerateSyntaxTreeTool {
  constructor(
    private readonly graph: GraphService,
    private readonly calls: CallLogService,
  ) {}

  @Tool({
    name: GenerateSyntaxTreeToolSpec.name,
    description: GenerateSyntaxTreeToolSpec.description,
    parameters: GenerateSyntaxTreeToolSpec.parameters,
  })
  async run(input: { project: string; language?: string[] }) {
    return this.calls.track("generate_syntax_tree", "mcp", input, () =>
      this.graph.generateSyntaxTree(input.project, input.language),
    );
  }
}

registerTool({ cls: GenerateSyntaxTreeTool, spec: GenerateSyntaxTreeToolSpec });