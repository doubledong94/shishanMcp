import { Injectable, Logger, BadRequestException } from "@nestjs/common";
import {
  ScipClientService,
  ScipIndexJson,
  ScipDocument,
} from "./scip-client.service";
import { CodeReaderService } from "../code-reader.service";

export interface ScipDocSummary {
  /** 相对项目根的路径 */
  relative_path: string;
  language: string;
  occurrences: number;
  /** SymbolInformation.symbol 中 maven 坐标为空（`.`）的符号数 */
  noCoordSymbols: number;
}

export interface ScipIndexSummary {
  project: string;
  tool?: string;
  toolVersion?: string;
  toolArguments?: string[];
  projectRoot?: string;
  /** text_document_encoding 的可读名（UTF8/UTF16/…） */
  textEncoding?: string;
  /** 协议版本（enum 序号） */
  protocolVersion?: number;
  documents: ScipDocSummary[];
  externalSymbols: number;
}

/**
 * 供调试控制台查看 SCIP 索引的结构与内容。
 *
 * 索引 JSON 可能很大（okhttp 约 60MB），因此：
 *  - 只在首次访问某个项目时从 scip 网关拉全量 JSON 并缓存到内存；
 *  - summary 只返回元信息 + 文档列表统计（不返回 occurrences）；
 *  - document(path) 按相对路径返回单个文档的完整内容（symbols + occurrences）。
 */
@Injectable()
export class ScipIndexViewerService {
  private readonly logger = new Logger(ScipIndexViewerService.name);

  /** project -> 已解析的完整索引（内存缓存）。 */
  private readonly cache = new Map<string, ScipIndexJson>();

  constructor(
    private readonly scip: ScipClientService,
    private readonly reader: CodeReaderService,
  ) {}

  private async load(project: string): Promise<ScipIndexJson> {
    let idx = this.cache.get(project);
    if (!idx) {
      this.logger.log(`加载 SCIP 索引: ${project}`);
      idx = await this.scip.getIndexJson(project);
      this.cache.set(project, idx);
    }
    return idx;
  }

  /** 供其他服务复用缓存索引。不存在返回 undefined。 */
  async loadIndex(project: string): Promise<ScipIndexJson | undefined> {
    try {
      return await this.load(project);
    } catch {
      return undefined;
    }
  }

  /** 项目概览：元信息 + 文档列表统计。 */
  async summary(project: string): Promise<ScipIndexSummary> {
    const idx = await this.load(project);
    const docs = (idx.documents || [])
      .map((d) => ({
        relative_path: d.relative_path,
        language: d.language,
        occurrences: (d.occurrences || []).length,
        noCoordSymbols: countNoCoordSymbols(d.symbols),
      }))
      .sort((a, b) => a.relative_path.localeCompare(b.relative_path));
    const meta = idx.metadata as
      | {
          tool_info?: { name?: string; version?: string; arguments?: string[] };
          project_root?: string;
          text_document_encoding?: number;
          version?: number;
        }
      | undefined;
    return {
      project,
      tool: meta?.tool_info?.name,
      toolVersion: meta?.tool_info?.version,
      toolArguments: meta?.tool_info?.arguments,
      projectRoot: meta?.project_root,
      textEncoding: textEncodingName(meta?.text_document_encoding),
      protocolVersion: meta?.version,
      documents: docs,
      externalSymbols: (idx.externalSymbols || []).length,
    };
  }

  /** 单个文档完整内容（symbols + occurrences）。 */
  async document(
    project: string,
    relativePath: string,
  ): Promise<{ found: boolean; document?: unknown }> {
    const idx = await this.load(project);
    const doc = (idx.documents || []).find((d) => d.relative_path === relativePath);
    if (!doc) return { found: false };
    return { found: true, document: doc };
  }

  /** 确认项目已挂载；否则抛错（与图谱工具一致）。 */
  assertMounted(project: string): void {
    if (!this.reader.resolveProject(project)) {
      throw new BadRequestException(`项目未挂载: ${project}`);
    }
  }
}

/** TextEncoding enum -> 可读名。 */
function textEncodingName(v: number | undefined): string | undefined {
  if (v === undefined) return undefined;
  return { 0: "Unspecified", 1: "UTF8", 2: "UTF16" }[v] ?? `#${v}`;
}

/**
 * 统计 doc 中 maven 坐标为空（package-name / version 为占位符 `.`）的
 * SymbolInformation 数量。SCIP symbol 格式：`<scheme> <manager> <pkg> <ver> <desc...>`。
 */
function countNoCoordSymbols(symbols: ScipDocument["symbols"]): number {
  if (!symbols?.length) return 0;
  let n = 0;
  for (const s of symbols) {
    const parts = String(s.symbol || "").split(" ");
    if (parts.length >= 4 && (parts[2] === "." || parts[3] === ".")) n++;
  }
  return n;
}
