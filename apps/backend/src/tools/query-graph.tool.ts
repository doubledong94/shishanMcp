import { Injectable } from "@nestjs/common";
import { Tool } from "@rekog/mcp-nest";
import { z } from "zod";
import { GraphService } from "../core/graph/graph.service";
import { CallLogService } from "../core/call-log.service";
import { ToolSpec } from "./tool-spec";
import { registerTool } from "./registry";
import { mountedProjectList, mountedProjectsHint } from "./mounted-projects";

/**
 * 预置 cypher 模板（图模型见 doc/GRAPH_MODEL.md，搜索语义见 doc/SEARCH_GUIDE.md）。
 * $project 由后端注入；锚定用的输入统一走 $name（来自 param 参数）。
 *
 * <p><b>三条硬规则</b>（理由见 GRAPH_MODEL.md「NEXT 流搜索的三条规则」）：
 * <ol>
 *   <li><b>每个模板都必须锚定</b>（needsParam=true，用 $name 收窄到具体节点/方法/类/包）。
 *       不锚定 = 全库扫全部起点做变长展开，实测 `count(p)` 跑 6 分 52 秒未完；LIMIT 拦不住，
 *       因为每行都要先算出来。
 *   <li><b>不写 LIMIT</b>。目的是把结果画到图上；LIMIT 会在懒拉取里静默截断路径，
 *       少画的边不报错。有界性由锚定保证，不由 LIMIT 保证。
 *   <li><b>NEXT 流不 `RETURN p`，改用去重边</b>（{@code UNWIND relationships(p) AS r WITH DISTINCT r}）。
 *       含环的 NEXT 流里节点数不多、路径数却能爆炸：CallServerInterceptor.intercept 一个方法体
 *       379 个节点 → 19238 条路径。`RETURN p` 实测 10s / 1.3GB，去重边 2s / 309KB，
 *       而画到图上两者是同一套边。{@code count(p)} 更糟（要实体化全部路径）。
 * </ol>
 */
const PRESETS: Record<string, { description: string; needsParam: boolean; cypher: string }> = {
  nesting: {
    description: "数据的分形：某实例引用出发的 引用→调用点→被调方法（需 param=值名）",
    needsParam: true,
    cypher:
      "MATCH p=(v:Value {projectId:$project, name:$name})-[:REF]->(cm:CalledMethod)-[:CALLS]->(m:Method) RETURN p",
  },
  dataflow: {
    description: "数据流：某值出发的值→值链（需 param=值名）",
    needsParam: true,
    cypher:
      "MATCH p=(a:Value {projectId:$project, name:$name})-[:FLOWS*]->(b:Value {projectId:$project}) RETURN p",
  },
  types: {
    description: "类继承关系：某类的直接父类（需 param=类名）",
    needsParam: true,
    cypher:
      "MATCH p=(c:Class {projectId:$project, name:$name})-[:EXTENDS]->(sup:Class) RETURN p",
  },
  polymorphism: {
    description: "多态：某方法实际派发到哪些实现（需 param=方法名）",
    needsParam: true,
    cypher:
      "MATCH p=(declared:Method {projectId:$project, name:$name})<-[:OVERRIDES*]-(impl:Method) RETURN p",
  },
  ancestors: {
    description: "类范围 super(C)：某类的所有祖先类（需 param=类名）",
    needsParam: true,
    cypher:
      "MATCH p=(c:Class {projectId:$project, name:$name})-[:EXTENDS*]->(a:Class) RETURN p",
  },
  descendants: {
    description: "类范围 sub(C)：某类的所有子孙类（需 param=类名）",
    needsParam: true,
    cypher:
      "MATCH p=(c:Class {projectId:$project, name:$name})<-[:EXTENDS*]-(d:Class) RETURN p",
  },
  inPackage: {
    description: "类范围 inPackage(P)：某包下的所有类（需 param=包名前缀）",
    needsParam: true,
    cypher:
      "MATCH (c:Class {projectId:$project}) WHERE c.package STARTS WITH $name RETURN c",
  },
  intersection: {
    description:
      "相交：数据流(值→实参) ∩ 数据的分形(实例→调用) 汇聚于同一调用点（需 param=值名，锚定数据流起点）",
    needsParam: true,
    cypher:
      "MATCH (v1:Value {projectId:$project, name:$name})-[:FLOWS]->(cp:Value {projectId:$project,kind:'CALLED_PARAM'})-[:ARG_OF]->(cm:CalledMethod)-[:CALLS]->(m:Method) MATCH (v2:Value {projectId:$project})-[:REF]->(cm) RETURN v1, cp, cm, m, v2",
  },
  codeorder: {
    description: "时机（时序主轴）：某方法体内的执行先后（需 param=方法名，从该方法沿 NEXT 走到函数尾）",
    needsParam: true,
    cypher:
      "MATCH (m:Method {projectId:$project, name:$name}) MATCH p=(m)-[:NEXT*]->(x {projectId:$project}) UNWIND relationships(p) AS r WITH DISTINCT r MATCH (a)-[r]->(b) RETURN a, r, b",
  },
  order_true: {
    description: "某表达式为 true 时的时序（需 param=表达式名，经 CONTROLS 找条件、走 then 的 NEXT 链）",
    needsParam: true,
    cypher:
      "MATCH (e:Value {projectId:$project, name:$name})-[:CONTROLS]->(c:Condition) MATCH p=(c)-[:NEXT*]->(x {projectId:$project}) UNWIND relationships(p) AS r WITH DISTINCT r MATCH (a)-[r]->(b) RETURN a, r, b",
  },
  order_false: {
    description: "某表达式为 false 时的时序（需 param=表达式名，走条件 else 分支的链）",
    needsParam: true,
    cypher:
      "MATCH (e:Value {projectId:$project, name:$name})-[:CONTROLS]->(c:Condition) MATCH p=(c)-[:NEXT {branch:'false'}]->(x {projectId:$project}) UNWIND relationships(p) AS r WITH DISTINCT r MATCH (a)-[r]->(b) RETURN a, r, b",
  },
};

const PRESET_NAMES = Object.keys(PRESETS) as [string, ...string[]];

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
    cypher: z
      .string()
      .optional()
      .describe("合法的 cypher 查询语句，可含 $project / $name 参数。preset 未给时使用"),
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
  async run(input: { project: string; preset?: string; param?: string; cypher?: string; name?: string }) {
    return this.calls.track("query_graph", "mcp", input, () => {
      const params: Record<string, unknown> = { project: input.project };
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
