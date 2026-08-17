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
    "确保某项目的符号图已写入 Neo4j 图数据库。" +
    "若 scip-java fork 已直写入库（用 --scip-java 部署时 generate_scip_index 通常已完成），直接返回统计；" +
    "否则回退到从已生成的 index.scip 导入。" +
    "需要先调用 generate_scip_index。当前已挂载项目：" + mountedProjectList(),
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