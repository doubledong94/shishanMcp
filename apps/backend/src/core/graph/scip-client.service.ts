import { Injectable, Logger } from "@nestjs/common";
import { GraphConfig } from "./graph-config";

export interface ScipJobState {
  id: string;
  status: "pending" | "running" | "done" | "failed";
  project?: string;
  language?: string;
  indexPath?: string;
  error?: string;
}

export interface ScipDocument {
  relative_path: string;
  language: string;
  symbols?: Array<{
    symbol: string;
    kind?: number;
    display_name?: string;
  }>;
  occurrences: Array<{
    symbol: string;
    range: [number, number];
    symbol_roles?: number;
  }>;
}

export interface ScipSymbolInfo {
  symbol: string;
  kind?: number;
  name?: string;
  signature?: string;
}

/**
 * HTTP 客户端，调用独立的 scip 网关容器（docker/scip）。
 *
 * 网关职责：接收索引任务、调用对应语言的 scip indexer 生成 index.scip、
 * 用 `scip print --json` 把 protobuf 转 JSON。本服务只负责 RPC + 轮询。
 */
@Injectable()
export class ScipClientService {
  private readonly logger = new Logger(ScipClientService.name);

  constructor(private readonly config: GraphConfig) {}

  private base(): string {
    return this.config.scipUrl;
  }

  /** 触发一次索引任务，返回 jobId。 */
  async submit(project: string, language: string): Promise<{ jobId: string }> {
    const res = await fetch(`${this.base()}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, language }),
    });
    if (!res.ok) {
      const body = await this.text(res);
      throw new Error(`scip 网关任务创建失败 (${res.status}): ${body}`);
    }
    return (await res.json()) as { jobId: string };
  }

  async getJob(jobId: string): Promise<ScipJobState> {
    const res = await fetch(`${this.base()}/api/jobs/${jobId}`);
    if (!res.ok) {
      throw new Error(`scip 网关查询任务失败 (${res.status})`);
    }
    return (await res.json()) as ScipJobState;
  }

  /** 等待任务结束（默认最多 10 分钟），返回最终状态。 */
  async waitForJob(
    jobId: string,
    timeoutMs = 600_000,
    pollMs = 2000,
  ): Promise<ScipJobState> {
    const start = Date.now();
    for (;;) {
      const job = await this.getJob(jobId);
      if (job.status === "done" || job.status === "failed") return job;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`scip 索引任务超时（${timeoutMs}ms）：job ${jobId}`);
      }
      await sleep(pollMs);
    }
  }

  /** 获取已生成索引的 JSON 表示（网关内部用 scip print --json）。 */
  async getIndexJson(project: string): Promise<ScipIndexJson> {
    const res = await fetch(`${this.base()}/api/index/${encodeURIComponent(project)}`);
    if (!res.ok) {
      throw new Error(`scip 网关读取索引失败 (${res.status}): ${await this.text(res)}`);
    }
    return (await res.json()) as ScipIndexJson;
  }

  private async text(res: Response): Promise<string> {
    try {
      return await res.text();
    } catch {
      return "";
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ScipIndexJson {
  metadata?: {
    version?: number;
    tool_info?: { name?: string; version?: string; arguments?: string[] };
    project_root?: string;
    text_document_encoding?: number;
  };
  documents?: ScipDocument[];
  externalSymbols?: ScipSymbolInfo[];
}