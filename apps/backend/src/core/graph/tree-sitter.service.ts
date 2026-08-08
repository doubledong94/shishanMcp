import { Injectable } from "@nestjs/common";
import * as fs from "node:fs";
import * as path from "node:path";
import * as tslp from "@kreuzberg/tree-sitter-language-pack";
import { GraphConfig } from "./graph-config";

export interface AstNode {
  kind: string;
  name?: string;
  /** 字节区间 [start, end)，与 SCIP 的 range 单位一致，便于关联。 */
  start: number;
  end: number;
  startLine?: number;
  endLine?: number;
  children: AstNode[];
}

export interface FileAst {
  /** 相对项目根目录的路径 */
  path: string;
  language: string;
  nodes: AstNode[];
  errorCount: number;
}

/**
 * 用 tree-sitter-language-pack（306 语言）把源文件解析成语法树，再转成
 * 便于存图的 JSON 结构（节点 + 字节区间 + 子节点）。
 *
 * grammar 由语言包按需下载；下载缓存目录指向数据盘（GraphConfig.tsCacheDir），
 * 重建容器后无需重新下载。下载需要访问 GitHub releases —— 网络受限时可能失败，
 * 失败会抛出清晰错误，由上层工具处理。
 */
@Injectable()
export class TreeSitterService {
  private configured = false;

  constructor(private readonly config: GraphConfig) {}

  private ensureConfigured(): void {
    if (!this.configured) {
      try {
        tslp.configure({ cacheDir: this.config.tsCacheDir });
      } catch {
        /* 缓存目录不可用时用默认目录，仍能工作 */
      }
      this.configured = true;
    }
  }

  /** 扩展名 → tree-sitter-language-pack 的语言名。未知返回 null。 */
  static languageForPath(relPath: string): string | null {
    try {
      const lang = tslp.detectLanguageFromPath(relPath);
      return lang;
    } catch {
      return null;
    }
  }

  /** 该语言是否可用（能解析）。会触发按需下载。 */
  static hasLanguage(name: string): boolean {
    try {
      return tslp.hasLanguage(name);
    } catch {
      return false;
    }
  }

  /**
   * 解析一个文件为语法树 AST。
   * @param code 文件内容
   * @param language 语言名（tree-sitter-language-pack 命名，如 "python"）
   * @param relPath 相对路径（仅用于附带信息）
   */
  parse(code: string, language: string, relPath: string): FileAst {
    this.ensureConfigured();
    let parser: tslp.Parser;
    try {
      parser = tslp.getParser(language);
    } catch (err) {
      throw new Error(
        `tree-sitter 无法加载语言 "${language}"（可能需要联网下载 grammar）：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const tree = parser.parse(code);
    if (!tree) {
      throw new Error(`tree-sitter 解析失败，返回空树: ${relPath}`);
    }
    const root = tree.rootNode();
    return {
      path: relPath,
      language,
      nodes: [toAstNode(root)],
      errorCount: countErrors(root),
    };
  }
}

function toAstNode(node: tslp.Node): AstNode {
  const result: AstNode = {
    kind: node.kind(),
    start: node.startByte(),
    end: node.endByte(),
    children: [],
  };
  const namedCount = node.namedChildCount();
  for (let i = 0; i < namedCount; i++) {
    const child = node.namedChild(i);
    if (child) result.children.push(toAstNode(child));
  }
  return result;
}

function countErrors(node: tslp.Node): number {
  let count = node.isError() ? 1 : 0;
  const namedCount = node.namedChildCount();
  for (let i = 0; i < namedCount; i++) {
    const child = node.namedChild(i);
    if (child) count += countErrors(child);
  }
  return count;
}