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
 * $project 由后端注入；需要额外输入（类名/包名）的模板用 $name（来自 param 参数）。
 */
const PRESETS: Record<string, { description: string; needsParam: boolean; cypher: string }> = {
  calls: {
    description: "调用图：方法→分支→调用点→被调方法（时机传递）",
    needsParam: false,
    cypher:
      "MATCH (m:Method {projectId:$project})-[:ROOT]->(:Condition)-[:SUB*0..]->(c:Condition)-[:LEADS_TO]->(cm:CalledMethod)-[:CALLS]->(callee:Method) RETURN m, c, cm, callee LIMIT 500",
  },
  callers: {
    description: "被调方法的所有调用方（谁调用了我）",
    needsParam: false,
    cypher:
      "MATCH (m:Method {projectId:$project})-[:ROOT]->(rc:Condition)<-[:SCOPED_BY]-(cm:CalledMethod)-[:CALLS]->(callee:Method) RETURN DISTINCT m, cm, callee LIMIT 500",
  },
  branches: {
    description: "所有分支及其通往的调用（逻辑控制）",
    needsParam: false,
    cypher:
      "MATCH (c:Condition {projectId:$project})-[:LEADS_TO]->(cm:CalledMethod)-[:CALLS]->(m:Method) RETURN c, cm, m LIMIT 500",
  },
  nesting: {
    description: "类嵌套：实例引用→调用点",
    needsParam: false,
    cypher:
      "MATCH (v:Value {projectId:$project})-[:REF]->(cm:CalledMethod)-[:CALLS]->(m:Method) RETURN v, cm, m LIMIT 500",
  },
  dataflow: {
    description: "数据流：值→值（赋值/末写/传参/返回值）",
    needsParam: false,
    cypher:
      "MATCH (a:Value {projectId:$project})-[:FLOWS*1..6]->(b:Value) RETURN a, b LIMIT 500",
  },
  controls: {
    description: "条件控制：哪些值守卫了哪些分支",
    needsParam: false,
    cypher:
      "MATCH (v:Value {projectId:$project})-[:CONTROLS]->(c:Condition)-[:LEADS_TO]->(cm:CalledMethod) RETURN v, c, cm LIMIT 500",
  },
  types: {
    description: "类继承关系（EXTENDS）",
    needsParam: false,
    cypher:
      "MATCH (c:Class {projectId:$project})-[:EXTENDS]->(sup:Class) RETURN c, sup LIMIT 500",
  },
  polymorphism: {
    description: "多态：调用抽象方法实际派发到哪些实现（OVERRIDES）",
    needsParam: false,
    cypher:
      "MATCH (cm:CalledMethod {projectId:$project})-[:CALLS]->(declared:Method) MATCH (declared)<-[:OVERRIDES*1..4]-(impl:Method) RETURN cm, declared, impl LIMIT 500",
  },
  ancestors: {
    description: "类范围 super(C)：某类的所有祖先类（需 param=类名）",
    needsParam: true,
    cypher:
      "MATCH (c:Class {projectId:$project, name:$name})-[:EXTENDS*1..4]->(a:Class) RETURN c, a LIMIT 500",
  },
  descendants: {
    description: "类范围 sub(C)：某类的所有子孙类（需 param=类名）",
    needsParam: true,
    cypher:
      "MATCH (c:Class {projectId:$project, name:$name})<-[:EXTENDS*1..4]-(d:Class) RETURN c, d LIMIT 500",
  },
  inPackage: {
    description: "类范围 inPackage(P)：某包下的所有类（需 param=包名前缀）",
    needsParam: true,
    cypher:
      "MATCH (c:Class {projectId:$project}) WHERE c.package STARTS WITH $name RETURN c LIMIT 500",
  },
  intersection: {
    description: "相交：数据流(值→实参) ∩ 类嵌套(实例→调用) 汇聚于同一调用点",
    needsParam: false,
    cypher:
      "MATCH (v1:Value {projectId:$project})-[:FLOWS]->(cp:Value {projectId:$project,kind:'CALLED_PARAM'})-[:ARG_OF]->(cm:CalledMethod)-[:CALLS]->(m:Method) MATCH (v2:Value {projectId:$project})-[:REF]->(cm) RETURN v1, cp, cm, m, v2 LIMIT 500",
  },
};

const PRESET_NAMES = Object.keys(PRESETS) as [string, ...string[]];

export const QueryGraphToolSpec: ToolSpec = {
  name: "query_graph",
  description:
    "对 Neo4j 图数据库执行一条 cypher 查询（通常返回路径/图），把结果中的节点与边存成快照，" +
    "并返回一个可打开的三维图页面 URL（GRAPH_VIEW_URL）。" +
    "可传 preset 用预置模板（部分需 param 提供类名/包名），或用 cypher 自定义。" +
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
      .describe("preset 模板需要的额外输入（对应 cypher 里的 $name，如类名/包名）"),
    cypher: z
      .string()
      .optional()
      .describe("合法的 cypher 查询语句，可含 $project / $name 参数。preset 未给时使用"),
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
  async run(input: { project: string; preset?: string; param?: string; cypher?: string }) {
    return this.calls.track("query_graph", "mcp", input, () => {
      const params: Record<string, unknown> = { project: input.project };
      if (input.param != null) params.name = input.param;
      if (input.preset && PRESETS[input.preset]) {
        const tpl = PRESETS[input.preset];
        if (tpl.needsParam && input.param == null) {
          return { error: `preset ${input.preset} 需要 param（${tpl.description}）` };
        }
        return this.graph.queryGraph(input.project, tpl.cypher, params);
      }
      const cypher = input.cypher || PRESETS.calls.cypher;
      return this.graph.queryGraph(input.project, cypher, params);
    });
  }
}

registerTool({ cls: QueryGraphTool, spec: QueryGraphToolSpec });
