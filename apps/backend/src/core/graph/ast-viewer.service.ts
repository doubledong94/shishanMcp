import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import * as fs from "node:fs";
import * as path from "node:path";
import { DataStoreService } from "../data-store.service";
import { CodeReaderService } from "../code-reader.service";
import { FileAst } from "./tree-sitter.service";

export interface AstFileSummary {
  /** ast 文件相对 ast 目录的路径 */
  astPath: string;
  /** 源文件相对项目根的路径（从 ast.json 里读） */
  sourcePath?: string;
  language: string;
  errorCount?: number;
}

export interface AstSummary {
  project: string;
  astRoot: string;
  files: AstFileSummary[];
  /** 各语言的文件数统计 */
  byLanguage: Record<string, number>;
  totalErrors: number;
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
    if (!dir) return { project, astRoot: "", files: [], byLanguage: {}, totalErrors: 0 };

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
          try {
            const raw = fs.readFileSync(full, "utf8");
            // 大文件不必整体解析成对象再丢弃，这里只读前 512B 拿 path/language。
            const head = raw.slice(0, 2048);
            const m = head.match(/"language"\s*:\s*"([^"]+)"/);
            if (m) language = m[1];
            const em = head.match(/"errorCount"\s*:\s*(\d+)/);
            if (em) errorCount = Number(em[1]);
          } catch {
            /* skip */
          }
          if (language) byLanguage[language] = (byLanguage[language] || 0) + 1;
          if (errorCount) totalErrors += errorCount;
          files.push({
            astPath: path.relative(dir, full),
            language,
            errorCount,
          });
        }
      }
    };
    walk(dir);

    files.sort((a, b) => a.astPath.localeCompare(b.astPath));
    return { project, astRoot: dir, files, byLanguage, totalErrors };
  }

  /** 读取单个 ast.json 的完整内容（AST 树），并附带源文件文本（用于按区间展示代码）。 */
  async tree(
    project: string,
    astPath: string,
  ): Promise<{ found: boolean; ast?: FileAst; source?: string }> {
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
      return { found: true, ast, source };
    } catch {
      return { found: false };
    }
  }
}
