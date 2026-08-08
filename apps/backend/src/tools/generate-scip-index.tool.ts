import { Injectable } from "@nestjs/common";
import { Tool } from "@rekog/mcp-nest";
import { z } from "zod";
import { GraphService } from "../core/graph/graph.service";
import { CallLogService } from "../core/call-log.service";
import { ToolSpec } from "./tool-spec";
import { registerTool } from "./registry";
import { mountedProjectList, mountedProjectsHint } from "./mounted-projects";

export const GenerateScipIndexToolSpec: ToolSpec = {
  name: "generate_scip_index",
  description:
    "对某个已挂载的项目调用 scip 索引服务（独立 docker 网关）生成 index.scip（精确符号图）。" +
    "生成结果落盘到数据目录，之后可用 import_to_graph 导入图数据库。" +
    "当前已挂载项目：" + mountedProjectList(),
  parameters: z.object({
    project: z
      .string()
      .describe(
        "项目名（即同路径挂载项目（绝对路径）的目录名）。" + mountedProjectsHint(),
      ),
    language: z
      .string()
      .describe(
        "scip 索引器语言名。scip 只覆盖主流语言（如 typescript/javascript/python/go/java/ruby/cpp/csharp/rust）；" +
          "不支持的会被网关拒绝",
      ),
  }),
};

@Injectable()
export class GenerateScipIndexTool {
  constructor(
    private readonly graph: GraphService,
    private readonly calls: CallLogService,
  ) {}

  @Tool({
    name: GenerateScipIndexToolSpec.name,
    description: GenerateScipIndexToolSpec.description,
    parameters: GenerateScipIndexToolSpec.parameters,
  })
  async run(input: { project: string; language: string }) {
    return this.calls.track("generate_scip_index", "mcp", input, () =>
      this.graph.generateScipIndex(input.project, input.language),
    );
  }
}

registerTool({ cls: GenerateScipIndexTool, spec: GenerateScipIndexToolSpec });