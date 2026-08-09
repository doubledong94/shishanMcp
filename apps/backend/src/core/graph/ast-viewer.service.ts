import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import * as fs from "node:fs";
import * as path from "node:path";
import { DataStoreService } from "../data-store.service";
import { CodeReaderService } from "../code-reader.service";
import { FileAst } from "./tree-sitter.service";
import { ScipIndexViewerService } from "./scip-index-viewer.service";

export interface AstFileSummary {
  /** ast 文件相对 ast 目录的路径 */
  astPath: string;
  /** 源文件相对项目根的路径（从 ast.json 里读） */
  sourcePath?: string;
  language: string;
  errorCount?: number;
  /** 该源文件是否在 SCIP index 中有对应 document */
  hasIndex: boolean;
}

export interface AstSummary {
  project: string;
  astRoot: string;
  files: AstFileSummary[];
  /** 各语言的文件数统计 */
  byLanguage: Record<string, number>;
  totalErrors: number;
  /** 有 SCIP index 的文件数 */
  indexedFiles: number;
}

/** SCIP occurrence 附带换算后的字节区间（供前端与 tree-sitter 字节偏移匹配）。 */
export interface MatchedOccurrence {
  symbol: string;
  symbol_roles?: number;
  /** SCIP 原始 range（0-based 行 + UTF-16 code unit 字符偏移） */
  scipRange: {
    line: number;
    start_character: number;
    end_character: number;
  };
  /** 换算后的源文件字节区间 [start, end)，与 tree-sitter node 的 start/end 一致 */
  byteRange: [number, number];
}

/**
 * 供调试控制台查看 generate_syntax_tree 落盘的语法树（*.ast.json）。
 *
 * 语法树文件在 <DATA_ROOT>/ast/<project>/ 下，镜像项目目录结构，每个源文件
 * 对应一个 <不含扩展名>.ast.json。summary 只返回文件列表 + 语言统计；
 * tree(path) 读取单个 ast.json 返回完整 AST（节点树），由前端折叠展示。
 */
@Injectable()
export class AstViewerService {
  private readonly logger = new Logger(AstViewerService.name);

  constructor(
    private readonly data: DataStoreService,
    private readonly reader: CodeReaderService,
    private readonly scipViewer: ScipIndexViewerService,
  ) {}

  /** 某项目的 ast 目录；不存在返回 null。 */
  private astDir(project: string): string | null {
    const dir = path.join(this.data.getRoot(), "ast", project);
    return fs.existsSync(dir) ? dir : null;
  }

  /** 确认项目已挂载；否则抛错（与图谱工具一致）。 */
  assertMounted(project: string): void {
    if (!this.reader.resolveProject(project)) {
      throw new BadRequestException(`项目未挂载: ${project}`);
    }
  }

  /** 项目语法树文件列表 + 语言统计（只读文件元信息，不解析全量内容）。 */
  async summary(project: string): Promise<AstSummary> {
    const dir = this.astDir(project);
    if (!dir) return { project, astRoot: "", files: [], byLanguage: {}, totalErrors: 0, indexedFiles: 0 };

    const files: AstFileSummary[] = [];
    const byLanguage: Record<string, number> = {};
    let totalErrors = 0;

    const walk = (dirPath: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dirPath, e.name);
        if (e.isDirectory()) {
          walk(full);
        } else if (e.name.endsWith(".ast.json")) {
          let language = "";
          let errorCount: number | undefined;
          let sourcePath: string | undefined;
          try {
            const raw = fs.readFileSync(full, "utf8");
            // 大文件不必整体解析成对象再丢弃，这里只读前 512B 拿 path/language。
            const head = raw.slice(0, 2048);
            const m = head.match(/"language"\s*:\s*"([^"]+)"/);
            if (m) language = m[1];
            const em = head.match(/"errorCount"\s*:\s*(\d+)/);
            if (em) errorCount = Number(em[1]);
            const pm = head.match(/"path"\s*:\s*"([^"]+)"/);
            if (pm) sourcePath = pm[1];
          } catch {
            /* skip */
          }
          if (language) byLanguage[language] = (byLanguage[language] || 0) + 1;
          if (errorCount) totalErrors += errorCount;
          files.push({
            astPath: path.relative(dir, full),
            language,
            errorCount,
            sourcePath,
            hasIndex: false,
          });
        }
      }
    };
    walk(dir);

    files.sort((a, b) => a.astPath.localeCompare(b.astPath));

    // 对照 SCIP index：源文件相对项目根的路径若存在于 index documents，则标记 hasIndex。
    const indexed = new Set<string>();
    try {
      const idx = await this.scipViewer.loadIndex(project);
      for (const doc of idx?.documents || []) indexed.add(doc.relative_path);
    } catch (err) {
      this.logger.warn(`AST summary 读取 SCIP index 失败: ${project} ${err instanceof Error ? err.message : err}`);
    }

    let indexedFiles = 0;
    for (const f of files) {
      const sourcePath = f.sourcePath;
      if (sourcePath !== undefined && indexed.has(sourcePath)) {
        f.hasIndex = true;
        indexedFiles++;
      }
    }

    return { project, astRoot: dir, files, byLanguage, totalErrors, indexedFiles };
  }

  /** 读取单个 ast.json 的完整内容（AST 树），并附带源文件文本（用于按区间展示代码）。 */
  async tree(
    project: string,
    astPath: string,
  ): Promise<{ found: boolean; ast?: FileAst; source?: string; occurrences?: MatchedOccurrence[] }> {
    const dir = this.astDir(project);
    const full = dir ? path.join(dir, astPath) : "";
    if (!dir || !full.startsWith(dir) || !fs.existsSync(full) || !full.endsWith(".ast.json")) {
      return { found: false };
    }
    try {
      const ast = JSON.parse(fs.readFileSync(full, "utf8")) as FileAst;
      let source: string | undefined;
      const root = this.reader.resolveProject(project);
      if (root && ast.path) {
        const srcFile = path.join(root, ast.path);
        if (fs.existsSync(srcFile)) {
          try {
            source = fs.readFileSync(srcFile, "utf8");
          } catch {
            /* 源文件不可读时跳过（虚拟文档等） */
          }
        }
      }
      const occurrences = await this.matchOccurrences(project, ast, source);
      return { found: true, ast, source, occurrences };
    } catch {
      return { found: false };
    }
  }

  /**
   * 把 SCIP index 中该文件的 occurrence 换算成字节区间，供前端与 tree-sitter 叶子节点匹配。
   *
   * SCIP 的 range 是 0-based 行 + UTF-16 code unit 字符偏移（JVM 实现，position_encoding 未设置但
   * 用 UTF-16）；tree-sitter 的 node.start/end 是源文件字节偏移。这里按行把 UTF-16 偏移换算成
   * 字节偏移，保证两端坐标一致。
   */
  private async matchOccurrences(
    project: string,
    ast: FileAst,
    source: string | undefined,
  ): Promise<MatchedOccurrence[] | undefined> {
    if (!ast.path || source === undefined) return undefined;
    let idx;
    try {
      idx = await this.scipViewer.loadIndex(project);
    } catch {
      return undefined;
    }
    const doc = idx?.documents?.find((d) => d.relative_path === ast.path);
    if (!doc || !doc.occurrences?.length) return [];

    const lineIndex = buildLineIndex(source);
    const result: MatchedOccurrence[] = [];
    for (const occ of doc.occurrences) {
      const range = extractScipRange(occ);
      if (!range) continue;
      const byteRange = scipRangeToByteRange(source, lineIndex, range);
      if (!byteRange) continue;
      result.push({
        symbol: occ.symbol,
        symbol_roles: occ.symbol_roles,
        scipRange: range,
        byteRange,
      });
    }
    return result;
  }
}

/**
 * 每行的字节偏移信息。
 * 行号 0-based；lineByteStarts[i] 是第 i 行首字符的源文件字节偏移，
 * lineCodeUnitStarts[i] 是第 i 行首字符的 code unit 索引。
 */
interface LineIndex {
  /** 每行首字符的字节偏移 */
  byteStarts: number[];
  /** 每行首字符的 code unit 索引（用于取整行文本） */
  codeUnitStarts: number[];
}

function buildLineIndex(text: string): LineIndex {
  const byteStarts: number[] = [0];
  const codeUnitStarts: number[] = [0];
  let byte = 0;
  let codeUnits = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    byte += byteLengthUtf8(c);
    codeUnits++;
    if (c === 0x0a) {
      byteStarts.push(byte);
      codeUnitStarts.push(codeUnits);
    }
  }
  return { byteStarts, codeUnitStarts };
}

/** 单行文本里前 n 个 UTF-16 code unit 占用的 UTF-8 字节数；n 越界返回 null。 */
function codeUnitsToBytes(line: string, n: number): number | null {
  if (n < 0 || n > line.length) return null;
  let bytes = 0;
  for (let i = 0; i < n; i++) bytes += byteLengthUtf8(line.charCodeAt(i));
  return bytes;
}

/** 单个 UTF-16 code unit 的 UTF-8 字节数。 */
function byteLengthUtf8(code: number): number {
  if (code <= 0x7f) return 1;
  if (code <= 0x7ff) return 2;
  // 代理区（高/低代理项）各占 3 字节，一对合 4 字节
  return 3;
}

/** 从 occurrence 提取 SCIP range（兼容 single_line_range / 旧 range 数组）。 */
function extractScipRange(occ: {
  symbol: string;
  symbol_roles?: number;
  range?: [number, number, number] | [number, number, number, number];
  TypedRange?: unknown;
  typed_range?: unknown;
}): { line: number; start_character: number; end_character: number } | null {
  const tr = occ.TypedRange ?? occ.typed_range;
  const single = (tr as any)?.SingleLineRange;
  if (
    single &&
    typeof single.line === "number" &&
    typeof single.start_character === "number" &&
    typeof single.end_character === "number"
  ) {
    return { line: single.line, start_character: single.start_character, end_character: single.end_character };
  }
  const multi = (tr as any)?.MultiLineRange;
  if (multi && typeof multi.start_line === "number") {
    // 多行 range 只取首行到末行整体；对单 token 匹配意义不大，返回 null 跳过
    return null;
  }
  const r = occ.range;
  if (r && r.length >= 3) return { line: r[0], start_character: r[1], end_character: r[2] };
  return null;
}

/** SCIP (line, UTF-16 code unit offset) → 源文件字节区间。范围越界返回 null。 */
function scipRangeToByteRange(
  text: string,
  lineIndex: LineIndex,
  r: { line: number; start_character: number; end_character: number },
): [number, number] | null {
  const { byteStarts, codeUnitStarts } = lineIndex;
  if (r.line < 0 || r.line >= byteStarts.length) return null;
  const lineByteStart = byteStarts[r.line];
  const lineCodeUnitStart = codeUnitStarts[r.line];
  const lineEndCodeUnit = r.line + 1 < codeUnitStarts.length ? codeUnitStarts[r.line + 1] : text.length;
  const line = text.slice(lineCodeUnitStart, lineEndCodeUnit);
  const sc = codeUnitsToBytes(line, r.start_character);
  const ec = codeUnitsToBytes(line, r.end_character);
  if (sc == null || ec == null || ec < sc) return null;
  return [lineByteStart + sc, lineByteStart + ec];
}
