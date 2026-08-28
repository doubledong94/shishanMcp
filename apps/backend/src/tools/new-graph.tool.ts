import { Injectable } from "@nestjs/common";
import { Tool } from "@rekog/mcp-nest";
import { z } from "zod";
import { GraphService } from "../core/graph/graph.service";
import { CallLogService } from "../core/call-log.service";
import { ToolSpec } from "./tool-spec";
import { registerTool } from "./registry";
import { mountedProjectList, mountedProjectsHint } from "./mounted-projects";

/*
 * 与 query_graph（增量并入）配合：
 *  - query_graph 每次把结果并进「当前工作图」（固定 3D 页实时累积显示）
 *  - new_graph 把当前累积的工作图以 name 命名保存为历史快照，然后清空、开新图
 * 用于换一个分析主题时，把旧主题的图保存下来（有意义的名字便于回看）。
 */
export const NewGraphToolSpec: ToolSpec = {
  name: "new_graph",
  description:
    "把当前累积的工作图以 name 命名保存为一份历史快照（保存的名字要有意义，便于事后回看），" +
    "然后清空工作图、开启一张新图。与 query_graph 的增量并入配合：query_graph 把结果并进当前工作图（固定 3D 页面实时累积），" +
    "想换一个分析主题时调用本工具保存旧图、开新图。若当前工作图为空则返回 nothingToSave。" +
    "当前已挂载项目：" + mountedProjectList(),
  parameters: z.object({
    project: z
      .string()
      .describe(
        "项目名（同路径挂载项目（绝对路径）的目录名）。" + mountedProjectsHint(),
      ),
    name: z
      .string()
      .optional()
      .describe(
        "保存时给这份图起的名字，要能表达内容/主题（如 '充值流程调用链'、'证书校验相关调用'）。缺省自动按内容生成",
      ),
  }),
};

@Injectable()
export class NewGraphTool {
  constructor(
    private readonly graph: GraphService,
    private readonly calls: CallLogService,
  ) {}

  @Tool({
    name: NewGraphToolSpec.name,
    description: NewGraphToolSpec.description,
    parameters: NewGraphToolSpec.parameters,
  })
  async run(input: { project: string; name?: string }) {
    return this.calls.track("new_graph", "mcp", input, () =>
      this.graph.newGraph(input.project, input.name || ""),
    );
  }
}

registerTool({ cls: NewGraphTool, spec: NewGraphToolSpec });
