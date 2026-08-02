import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { DataStoreService } from "./data-store.service";

export interface CallRecord {
  id: string;
  tool: string;
  source: "mcp" | "rest";
  params: unknown;
  result: unknown;
  status: "success" | "error";
  durationMs: number;
  error?: string;
  timestamp: string;
}

/**
 * In-memory ring buffer of tool calls. Every MCP tool invocation and every
 * REST `/api/run` call is recorded here so the web console can show:
 *   调用参数 (params) / 调用返回 (result) / 耗时 / 来源 / 状态
 *
 * The ring buffer is a console aid; in addition each call is appended to the
 * data mount (<DATA_ROOT>/logs/calls-YYYY-MM-DD.jsonl) so history survives
 * container rebuilds. On startup the buffer is hydrated from that history, so
 * the console keeps showing past calls across restarts. Persistence is
 * best-effort — if the data mount is not writable, the in-memory log still works.
 */
@Injectable()
export class CallLogService {
  private readonly buffer: CallRecord[] = [];
  private readonly MAX = 500;

  constructor(private readonly data: DataStoreService) {
    this.hydrate();
  }

  /** Reload the in-memory buffer from persisted history (newest first). */
  private hydrate(): void {
    const records: CallRecord[] = [];
    for (const line of this.data.readLogLines()) {
      try {
        records.push(JSON.parse(line) as CallRecord);
      } catch {
        /* skip corrupt line */
      }
    }
    records.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
    this.buffer.length = 0;
    this.buffer.push(...records.slice(0, this.MAX));
  }

  async track(
    tool: string,
    source: CallRecord["source"],
    params: unknown,
    fn: () => unknown,
  ): Promise<unknown> {
    const start = Date.now();
    try {
      const result = await fn();
      this.push({ tool, source, params, result, status: "success", durationMs: Date.now() - start });
      return result;
    } catch (err) {
      this.push({
        tool,
        source,
        params,
        result: null,
        status: "error",
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /** Newest first. */
  list(limit = 100): CallRecord[] {
    return this.buffer.slice(0, limit);
  }

  clear(): number {
    const n = this.buffer.length;
    this.buffer.length = 0;
    return n;
  }

  private push(entry: Omit<CallRecord, "id" | "timestamp">) {
    const record: CallRecord = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this.buffer.unshift(record);
    if (this.buffer.length > this.MAX) this.buffer.length = this.MAX;
    this.data.appendJson(
      `calls-${record.timestamp.slice(0, 10)}.jsonl`,
      record,
    );
  }
}