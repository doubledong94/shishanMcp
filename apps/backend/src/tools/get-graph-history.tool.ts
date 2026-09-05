import { Injectable } from "@nestjs/common";
import { Tool } from "@rekog/mcp-nest";
import { z } from "zod";
import { GraphService } from "../core/graph/graph.service";
import { CallLogService } from "../core/call-log.service";
import { ToolSpec } from "./tool-spec";
import { registerTool } from "./registry";
import { mountedProjectList, mountedProjectsHint } from "./mounted-projects";

/*
 * 只读查询：返回某项目"当前工作图"由哪些搜索语句叠加而成（history）。
 * query_graph / HTTP 探索每次把结果增量并入当前工作图并追加一条 history；
 * new_graph 保存旧图并清空、加载已保存视图则整图替换 current。本工具据此
 * 让 AI 在介入前先知道当前这张图是怎么叠出来的。
 */
export const GetGraphHistoryToolSpec: ToolSpec = {
  name: "get_graph_history",
  description:
    "只读返回某项目「当前工作图」的叠加搜索历史——这张图依次由哪些搜索语句累加而成" +
    "（按并入顺序列出，每条含 revision / 语义名 name / 实际执行的 cypher / preset / 新增节点边数 / 时间）" +
    "，name 反映每条「搜了什么」（如 preset 名、查询目标或「扩展 <节点> 沿 <方向>」），" +
    "并附当前图的节点边计数与 revision。在你想基于当前图继续分析前，可先调用它了解这张图的来历。" +
    "可选传 viewId 查看某张已保存快照自己的历史（缺省即当前工作图）。" +
    "当前已挂载项目：" + mountedProjectList(),
  parameters: z.object({
    project: z
      .string()
      .describe(
        "项目名（同路径挂载项目（绝对路径）的目录名）。" + mountedProjectsHint(),
      ),
    viewId: z
      .string()
      .optional()
      .describe(
        "可选：某张已保存视图的 id。给了则返回该快照自己的叠加历史，缺省返回当前工作图的历史",
      ),
  }),
};

@Injectable()
export class GetGraphHistoryTool {
  constructor(
    private readonly graph: GraphService,
    private readonly calls: CallLogService,
  ) {}

  @Tool({
    name: GetGraphHistoryToolSpec.name,
    description: GetGraphHistoryToolSpec.description,
    parameters: GetGraphHistoryToolSpec.parameters,
  })
  async run(input: { project: string; viewId?: string }) {
    return this.calls.track("get_graph_history", "mcp", input, () =>
      this.graph.getGraphHistory(input.project, input.viewId || undefined),
    );
  }
}

registerTool({ cls: GetGraphHistoryTool, spec: GetGraphHistoryToolSpec });
