import { Injectable, Logger } from "@nestjs/common";
import neo4j, { Driver, Session } from "neo4j-driver";
import { GraphConfig } from "./graph-config";

/**
 * Neo4j 连接封装（bolt）。
 *
 * 提供：建约束、跑 cypher、把路径/图结果转成前端 Three.js 能渲染的
 * nodes/edges 结构。写入与查询都用参数化 cypher，避免注入。
 */
@Injectable()
export class Neo4jService {
  private readonly logger = new Logger(Neo4jService.name);
  private driver: Driver | null = null;
  private ready = false;

  constructor(private readonly config: GraphConfig) {}

  private getDriver(): Driver {
    if (!this.driver) {
      if (!this.config.neo4jPassword) {
        throw new Error("未配置 NEO4J_PASSWORD，无法连接图数据库");
      }
      this.driver = neo4j.driver(
        this.config.neo4jUrl,
        neo4j.auth.basic(this.config.neo4jUser, this.config.neo4jPassword),
        { maxConnectionLifetime: 3 * 60 * 60 * 1000 },
      );
    }
    return this.driver;
  }

  session(mode: "read" | "write" = "read"): Session {
    return this.getDriver().session({ defaultAccessMode: mode === "write" ? "WRITE" : "READ" });
  }

  /** 建约束/索引（幂等，idempotent）。 */
  async ensureSchema(): Promise<void> {
    if (this.ready) return;
    const session = this.session("write");
    try {
      for (const q of [
        "CREATE CONSTRAINT project_id IF NOT EXISTS FOR (p:Project) REQUIRE p.id IS UNIQUE",
        "CREATE INDEX file_uniq IF NOT EXISTS FOR (f:File) ON (f.projectId, f.path)",
        "CREATE INDEX symbol_name IF NOT EXISTS FOR (s:Symbol) ON (s.name)",
      ]) {
        await session.run(q);
      }
      this.ready = true;
    } finally {
      await session.close();
    }
  }

  /** 执行一条 cypher，返回 neo4j 原生记录。 */
  async run(query: string, params: Record<string, unknown> = {}, mode: "read" | "write" = "read") {
    const session = this.session(mode);
    try {
      const result = await session.run(query, params);
      return result.records;
    } finally {
      await session.close();
    }
  }

  /** 统计某项目在图数据库中的节点数（按标签）。 */
  async countProject(project: string): Promise<Record<string, number>> {
    const labels = ["Class", "Method", "Field", "Value", "CalledMethod", "Condition"];
    const counts: Record<string, number> = {};
    const session = this.session("read");
    try {
      for (const label of labels) {
        const result = await session.run(
          `MATCH (n:\`${label}\` {projectId: $project}) RETURN count(n) AS c`,
          { project },
        );
        counts[label] = neo4j.integer.toNumber(result.records[0].get("c"));
      }
    } finally {
      await session.close();
    }
    return counts;
  }

  /** 一次事务内批量执行多条 cypher（用于导入）。 */
  async runAll<T>(statements: Array<{ query: string; params: Record<string, unknown> }>): Promise<void> {
    if (statements.length === 0) return;
    const session = this.session("write");
    const tx = session.beginTransaction();
    try {
      for (const st of statements) {
        await tx.run(st.query, st.params);
      }
      await tx.commit();
    } catch (err) {
      try {
        await tx.rollback();
      } catch {
        /* ignore */
      }
      throw err;
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
    }
  }
}