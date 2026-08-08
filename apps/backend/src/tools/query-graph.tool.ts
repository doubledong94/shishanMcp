import { Injectable } from "@nestjs/common";
import { Tool } from "@rekog/mcp-nest";
import { z } from "zod";
import { GraphService } from "../core/graph/graph.service";
import { CallLogService } from "../core/call-log.service";
import { ToolSpec } from "./tool-spec";
import { registerTool } from "./registry";
import { mountedProjectList, mountedProjectsHint } from "./mounted-projects";

export const QueryGraphToolSpec: ToolSpec = {
  name: "query_graph",
  description:
    "对 Neo4j 图数据库执行一条 cypher 查询（通常返回路径/图），把结果中的节点与边存成快照，" +
    "并返回一个可打开的三维图页面 URL（GRAPH_VIEW_URL）。适合 Agent 提供 cypher（如 " +
    "MATCH p=(a:Symbol)-[:REFERENCES*1..5]->(b:Symbol) RETURN p）后把路径可视化。" +
    "当前已挂载项目：" + mountedProjectList(),
  parameters: z.object({
    project: z
      .string()
      .describe(
        "项目名（同路径挂载项目（绝对路径）的目录名）。" + mountedProjectsHint(),
      ),
    cypher: z
      .string()
      .describe("合法的 cypher 查询语句。仅执行；建议用 MATCH ... RETURN 形式"),
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
  async run(input: { project: string; cypher: string }) {
    return this.calls.track("query_graph", "mcp", input, () =>
      this.graph.queryGraph(input.project, input.cypher),
    );
  }
}

registerTool({ cls: QueryGraphTool, spec: QueryGraphToolSpec });