import { Injectable } from "@nestjs/common";
import { Tool } from "@rekog/mcp-nest";
import { z } from "zod";
import { GraphService } from "../core/graph/graph.service";
import { CallLogService } from "../core/call-log.service";
import { ToolSpec } from "./tool-spec";
import { registerTool } from "./registry";
import { mountedProjectList, mountedProjectsHint } from "./mounted-projects";

/*
 * 调用点 → 被调函数体：图谱页里长按/右键 CalledMethod 节点的「展开函数」走的就是这个工具。
 *
 * 为什么不复用 query_graph(preset=codeorder)：codeorder 靠 {name, file} 锚定，而站在调用点上
 * 你只知道被调方法的名字，不知道它声明在哪个文件——调用点自己的 file 是调用发生的位置。
 * 这个工具替调用方把 CALLS 那一跳走掉：解析出 Method 声明后，用它的 name + file 去跑 codeorder。
 */
export const ExpandCalledMethodToolSpec: ToolSpec = {
  name: "expand_called_method",
  description:
    "把一个调用点（CalledMethod 节点）展开成它调用的那个方法的函数体：沿 CALLS 边解析出被调 Method 声明，" +
    "再用 codeorder 模板查该方法的函数体（执行先后 NEXT + 值流向 FLOWS + 成员访问 REF + 分支守卫 CONTROLS" +
    " + 数据进出调用 PARAM_TO_METHOD/METHOD_TO_RETURN），结果连同一条 CALLS 边增量并入当前工作图。" +
    "与 query_graph(preset=codeorder) 的区别：后者需要你给出**被调方法名 + 声明所在文件**，" +
    "而站在调用点上通常只知道方法名（调用点的 file 是调用发生的位置，不是声明位置）——本工具代你走 CALLS 这一跳。" +
    "需要 id：调用点的稳定 id（= 节点的 stableId，Neo4j 的 id 属性，形如 " +
    "'okhttp::okhttp/src/…/Foo.kt#42:18'），可从图节点或查询结果里取。" +
    "少数调用点没有 CALLS 出边（链式调用的中间行），会返回 error 而非视图。" +
    "当前已挂载项目：" + mountedProjectList(),
  parameters: z.object({
    project: z
      .string()
      .describe(
        "项目名（同路径挂载项目（绝对路径）的目录名）。" + mountedProjectsHint(),
      ),
    id: z
      .string()
      .describe(
        "调用点（CalledMethod）的稳定 id —— 即该节点的 stableId，形如 'okhttp::<相对路径>#<行>:<列>'。" +
          "不是前端的 node-<identity>（那个每次重建索引都会变）。",
      ),
    name: z
      .string()
      .optional()
      .describe(
        "本次搜索的语义名（展示在搜索历史面板、并经 get_graph_history 返回）。缺省为「展开函数 <被调方法名>」",
      ),
  }),
};

@Injectable()
export class ExpandCalledMethodTool {
  constructor(
    private readonly graph: GraphService,
    private readonly calls: CallLogService,
  ) {}

  @Tool({
    name: ExpandCalledMethodToolSpec.name,
    description: ExpandCalledMethodToolSpec.description,
    parameters: ExpandCalledMethodToolSpec.parameters,
  })
  async run(input: { project: string; id: string; name?: string }) {
    return this.calls.track("expand_called_method", "mcp", input, () =>
      this.graph.expandCalledMethod(input.project, input.id, input.name),
    );
  }
}

registerTool({ cls: ExpandCalledMethodTool, spec: ExpandCalledMethodToolSpec });
