import { Injectable } from "@nestjs/common";
import { DataStoreService } from "../data-store.service";

/**
 * Graph 功能的外部依赖配置（scip 网关 / Neo4j）。
 *
 * 全部来自环境变量，与现有服务的约定一致：容器里用 compose 注入，本地开发缺省
 * 时给出合理默认值（scip/neo4j 本地连不上的情况下，工具会返回清晰报错，不崩溃）。
 */
@Injectable()
export class GraphConfig {
  readonly scipUrl: string;
  readonly neo4jUrl: string;
  readonly neo4jUser: string;
  readonly neo4jPassword: string;
  /** 图谱 3D 页对外访问地址（query_graph 返回的 viewUrl 前缀）。 */
  readonly viewBaseUrl: string;

  constructor(private readonly data: DataStoreService) {
    this.scipUrl = (process.env.SCIP_URL || "http://scip:8000").replace(/\/+$/, "");
    this.neo4jUrl = process.env.NEO4J_URL || "bolt://neo4j:7687";
    this.neo4jUser = process.env.NEO4J_USER || "neo4j";
    this.neo4jPassword = process.env.NEO4J_PASSWORD || "";
    this.viewBaseUrl = (process.env.GRAPH_VIEW_URL || "http://localhost:18081").replace(/\/+$/, "");
  }
}