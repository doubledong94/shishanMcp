import { Injectable } from "@nestjs/common";
import { Tool } from "@rekog/mcp-nest";
import { z } from "zod";
import { GraphService } from "../core/graph/graph.service";
import { CallLogService } from "../core/call-log.service";
import { ToolSpec } from "./tool-spec";
import { registerTool } from "./registry";
import { mountedProjectList, mountedProjectsHint } from "./mounted-projects";

export const ImportToGraphToolSpec: ToolSpec = {
  name: "import_to_graph",
  description:
    "读取某项目已生成的 index.scip（SCIP 符号图）和语法树（tree-sitter），合并写入 Neo4j 图数据库。" +
    "需要先调用 generate_scip_index 和/或 generate_syntax_tree。写入参数化 cypher，防注入。" +
    "当前已挂载项目：" + mountedProjectList(),
  parameters: z.object({
    project: z
      .string()
      .describe(
        "项目名（同路径挂载项目（绝对路径）的目录名）。" + mountedProjectsHint(),
      ),
  }),
};

@Injectable()
export class ImportToGraphTool {
  constructor(
    private readonly graph: GraphService,
    private readonly calls: CallLogService,
  ) {}

  @Tool({
    name: ImportToGraphToolSpec.name,
    description: ImportToGraphToolSpec.description,
    parameters: ImportToGraphToolSpec.parameters,
  })
  async run(input: { project: string }) {
    return this.calls.track("import_to_graph", "mcp", input, () =>
      this.graph.importGraph(input.project),
    );
  }
}

registerTool({ cls: ImportToGraphTool, spec: ImportToGraphToolSpec });