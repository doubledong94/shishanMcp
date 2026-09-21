import { Injectable } from "@nestjs/common";
import { Tool } from "@rekog/mcp-nest";
import { z } from "zod";
import { GraphService } from "../core/graph/graph.service";
import { PRESETS, PRESET_NAMES } from "../core/graph/presets";
import { CallLogService } from "../core/call-log.service";
import { ToolSpec } from "./tool-spec";
import { registerTool } from "./registry";
import { mountedProjectList, mountedProjectsHint } from "./mounted-projects";

export const QueryGraphToolSpec: ToolSpec = {
  name: "query_graph",
  description:
    "对 Neo4j 图数据库执行一条 cypher 查询（通常返回路径/图），把结果中的节点与边存成快照，" +
    "并返回一个可打开的三维图页面 URL（GRAPH_VIEW_URL）。" +
    "可传 preset 用预置模板（**每个 preset 都必须给 param 锚定到具体节点**），或用 cypher 自定义。" +
    "自定义 cypher 时务必自己锚定起点：不锚定会在全库做变长展开，实测会挂住（详见 preset 描述）。" +
    "预置模板：" + Object.entries(PRESETS).map(([k, v]) => `${k}(${v.description})`).join("；") +
    "。" + "当前已挂载项目：" + mountedProjectList(),
  parameters: z.object({
    project: z
      .string()
      .describe(
        "项目名（同路径挂载项目（绝对路径）的目录名）。" + mountedProjectsHint(),
      ),
    preset: z
      .enum(PRESET_NAMES)
      .optional()
      .describe("预置 cypher 模板名。给了 preset 时忽略 cypher"),
    param: z
      .string()
      .optional()
      .describe(
        "preset 模板的锚定输入（对应 cypher 里的 $name）：按 preset 填方法名/类名/包名前缀/值名。" +
          "每个 preset 都需要它——没有锚定的查询会在全库变长展开而挂住。",
      ),
    file: z
      .string()
      .optional()
      .describe(
        "可选的第二个锚定条件（对应 cypher 里的 $file，子串匹配）：同名方法/值很多时用它收窄到某一个，" +
          "如 file='CallServerInterceptor'。不传则不过滤。codeorder / polymorphism / order_* 支持",
      ),
    cypher: z
      .string()
      .optional()
      .describe("合法的 cypher 查询语句，可含 $project / $name / $file 参数。preset 未给时使用"),
    name: z
      .string()
      .optional()
      .describe(
        "本次搜索的语义名（说明这次查了什么，展示在搜索历史面板、并经 get_graph_history 返回给你）。" +
          "不给则后端按 preset 名或 cypher 摘要自动派生。",
      ),
  }),
};

@Injectable()
export class QueryGraphTool {
  constructor(
    private readonly graph: GraphService,
    private readonly calls: CallLogService,
  ) {}

  @Tool({
    name: QueryGraphToolSpec.name,
    description: QueryGraphToolSpec.description,
    parameters: QueryGraphToolSpec.parameters,
  })
  async run(input: {
    project: string;
    preset?: string;
    param?: string;
    file?: string;
    cypher?: string;
    name?: string;
  }) {
    return this.calls.track("query_graph", "mcp", input, () => {
      // $file 恒注入空串而不是不传：Neo4j 对缺参报错（"Expected parameter(s)"），
      // 而 `x.file CONTAINS ''` 恒真、正好等价于"不过滤"，这样模板不必写 OR 分支。
      const params: Record<string, unknown> = { project: input.project, file: input.file ?? "" };
      if (input.param != null) params.name = input.param;
      if (input.preset && PRESETS[input.preset]) {
        const tpl = PRESETS[input.preset];
        if (tpl.needsParam && input.param == null) {
          return { error: `preset ${input.preset} 需要 param（${tpl.description}）` };
        }
        return this.graph.queryGraph(input.project, tpl.cypher, params, input.preset, input.name);
      }
      // 既没给 preset 也没给 cypher：报错而不是回退到某个 preset——默认 preset 已随
      // calls/callers 的删除而消失，旧代码这里引用 PRESETS.calls 会直接抛异常。
      if (!input.cypher) {
        return {
          error: "需要 preset 或 cypher 之一（preset 见工具描述；自定义则传 cypher）",
        };
      }
      return this.graph.queryGraph(input.project, input.cypher, params, undefined, input.name);
    });
  }
}

registerTool({ cls: QueryGraphTool, spec: QueryGraphToolSpec });
