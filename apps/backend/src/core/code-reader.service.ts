import { Injectable } from "@nestjs/common";
import * as fs from "node:fs";
import * as path from "node:path";

export interface ReadFileResult {
  /** 相对项目根目录的路径 */
  path: string;
  /** 容器内解析出的绝对路径 */
  abs: string;
  /** 字节大小 */
  size: number;
  /** 行数 */
  lines: number;
  /** 完整内容（不分页） */
  content: string;
}

/**
 * Reads files from the mounted projects — the "option 1" (volume-mount) mode.
 *
 * Multi-project mode is the ONLY mode. Several projects are mounted under
 * `/workspace/<name>`; HOST_CODE_ROOT is their host-side common parent. The AI
 * knows only the host filesystem, so read_file requires a host ABSOLUTE path
 * (`/Users/me/proj-a/src/main.py`) and maps it to `/workspace/proj-a/...`.
 * Configuring a single project is the same thing with HOST_CODE_ROOT = that
 * project's root.
 *
 * If HOST_CODE_ROOT is unset it defaults to `/`, so any absolute host path maps
 * to `/workspace/<host path>`; the AI can still only read what is actually
 * mounted (unmounted files fail with "not found"), never escape.
 */
@Injectable()
export class CodeReaderService {
  private readonly root: string;
  private readonly hostRoot: string;

  constructor() {
    this.root = path.resolve(process.env.CODE_ROOT || "/workspace");
    this.hostRoot = process.env.HOST_CODE_ROOT
      ? path.resolve(process.env.HOST_CODE_ROOT)
      : "/";
  }

  getRoot(): string {
    return this.root;
  }

  getHostRoot(): string | null {
    return this.hostRoot;
  }

  /** List the mounted projects under the workspace root (name + host path). */
  listProjects(): { name: string; hostPath: string }[] {
    try {
      return fs
        .readdirSync(this.root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => ({
          name: d.name,
          hostPath: path.join(this.hostRoot, d.name),
        }));
    } catch {
      return [];
    }
  }

  /** Resolve a host absolute path to an absolute path inside the workspace root. */
  private resolve(input: string): string {
    if (!input || input.includes("\0")) {
      throw new Error("read_file: invalid path");
    }
    if (!path.isAbsolute(input)) {
      throw new Error(
        `read_file: path 必须是宿主机绝对路径（如 /Users/me/proj-a/src/main.py），收到相对路径 "${input}"`,
      );
    }
    const host = path.resolve(input);
    const rel = path.relative(this.hostRoot, host);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(
        `read_file: path "${input}" 不在允许的宿主机项目目录 ${this.hostRoot} 之内`,
      );
    }
    return path.resolve(this.root, rel);
  }

  /** Read a whole file (no paging). Accepts host absolute paths only. */
  readFile(input: string): ReadFileResult {
    const abs = this.resolve(input);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new Error(`read_file: path "${input}" escapes workspace root ${this.root}`);
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      throw new Error(`read_file: file not found: ${input}`);
    }
    if (!stat.isFile()) {
      throw new Error(`read_file: not a regular file: ${input}`);
    }
    const content = fs.readFileSync(abs, "utf8");
    const rel = path.relative(this.root, abs);
    return {
      path: rel || input,
      abs,
      size: Buffer.byteLength(content, "utf8"),
      lines: content.split("\n").length,
      content,
    };
  }
}
