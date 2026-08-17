import { Injectable } from "@nestjs/common";
import { Tool } from "@rekog/mcp-nest";
import { z } from "zod";
import { GraphService } from "../core/graph/graph.service";
import { CallLogService } from "../core/call-log.service";
import { ToolSpec } from "./tool-spec";
import { registerTool } from "./registry";
import { mountedProjectList, mountedProjectsHint } from "./mounted-projects";

/** 预置 cypher 模板（图模型见 doc/GRAPH_MODEL.md）。$project 由后端注入。 */
const PRESETS: Record<string, { description: string; cypher: string }> = {
  calls: {
    description: "调用图：方法→分支→调用点→被调方法（时机传递）",
    cypher:
      "MATCH (m:Method {projectId:$project})-[:ROOT]->(:Condition)-[:SUB*0..]->(c:Condition)-[:LEADS_TO]->(cm:CalledMethod)-[:CALLS]->(callee:Method) RETURN m, c, cm, callee LIMIT 500",
  },
  callers: {
    description: "被调方法的所有调用方（谁调用了我）",
    cypher:
      "MATCH (m:Method {projectId:$project})-[:ROOT]->(rc:Condition)<-[:SCOPED_BY]-(cm:CalledMethod)-[:CALLS]->(callee:Method) RETURN DISTINCT m, cm, callee LIMIT 500",
  },
  branches: {
    description: "所有分支及其通往的调用（逻辑控制）",
    cypher:
      "MATCH (c:Condition {projectId:$project})-[:LEADS_TO]->(cm:CalledMethod)-[:CALLS]->(m:Method) RETURN c, cm, m LIMIT 500",
  },
  nesting: {
    description: "类嵌套：实例引用→调用点",
    cypher:
      "MATCH (v:Value {projectId:$project})-[:REF]->(cm:CalledMethod)-[:CALLS]->(m:Method) RETURN v, cm, m LIMIT 500",
  },
  dataflow: {
    description: "数据流：值→值（赋值/末写/传参/返回值）",
    cypher:
      "MATCH (a:Value {projectId:$project})-[:FLOWS*1..6]->(b:Value) RETURN a, b LIMIT 500",
  },
  controls: {
    description: "条件控制：哪些值守卫了哪些分支",
    cypher:
      "MATCH (v:Value {projectId:$project})-[:CONTROLS]->(c:Condition)-[:LEADS_TO]->(cm:CalledMethod) RETURN v, c, cm LIMIT 500",
  },
  types: {
    description: "类继承关系（EXTENDS）",
    cypher:
      "MATCH (c:Class {projectId:$project})-[:EXTENDS]->(sup:Class) RETURN c, sup LIMIT 500",
  },
};

export const QueryGraphToolSpec: ToolSpec = {
  name: "query_graph",
  description:
    "对 Neo4j 图数据库执行一条 cypher 查询（通常返回路径/图），把结果中的节点与边存成快照，" +
    "并返回一个可打开的三维图页面 URL（GRAPH_VIEW_URL）。" +
    "可传 preset 用预置模板，或用 cypher 自定义。" +
    "预置模板：" + Object.entries(PRESETS).map(([k, v]) => `${k}(${v.description})`).join("；") +
    "。" + "当前已挂载项目：" + mountedProjectList(),
  parameters: z.object({
    project: z
      .string()
      .describe(
        "项目名（同路径挂载项目（绝对路径）的目录名）。" + mountedProjectsHint(),
      ),
    preset: z
      .enum(["calls", "callers", "branches", "nesting", "dataflow", "controls", "types"])
      .optional()
      .describe("预置 cypher 模板名。给了 preset 时忽略 cypher"),
    cypher: z
      .string()
      .optional()
      .describe("合法的 cypher 查询语句，可含 $project 参数。preset 未给时使用"),
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
  async run(input: { project: string; preset?: string; cypher?: string }) {
    return this.calls.track("query_graph", "mcp", input, () => {
      if (input.preset && PRESETS[input.preset]) {
        return this.graph.queryGraph(input.project, PRESETS[input.preset].cypher, {
          project: input.project,
        });
      }
      const cypher = input.cypher || PRESETS.calls.cypher;
      return this.graph.queryGraph(input.project, cypher, { project: input.project });
    });
  }
}

registerTool({ cls: QueryGraphTool, spec: QueryGraphToolSpec });