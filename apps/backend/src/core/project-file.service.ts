import { Injectable } from "@nestjs/common";
import * as fs from "node:fs";
import * as path from "node:path";
import { CodeReaderService } from "./code-reader.service";

/**
 * 图谱 3D 页的代码查看器后端：只读浏览已挂载项目的目录树 + 读取文件内容。
 *
 * 安全约束：
 *  - 只允许读写挂在项目根目录内的路径（同路径挂载，容器内=宿主机）；
 *  - 常见重型/二进制目录默认隐藏（.git / node_modules / build 等）；
 *  - 二进制文件与超大文件直接拒绝/截断。
 */

/** 默认隐藏的目录名（避免目录树巨大且无索引价值）。 */
const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".idea",
  ".vscode",
  ".gradle",
  ".venv",
  "node_modules",
  "__pycache__",
  ".cache",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "out",
  "target",
  "bin",
  "obj",
  "coverage",
  ".tox",
  ".terraform",
  "logs",
  "gradle",
  ".turbo",
]);

const MAX_FILE_BYTES = 512 * 1024;

export interface ProjectEntry {
  name: string;
  type: "dir" | "file";
  /** 相对项目根目录的路径（/ 分隔）。目录以 / 结尾。 */
  path: string;
}

export interface ProjectFile {
  path: string;
  content: string;
  truncated: boolean;
}

@Injectable()
export class ProjectFileService {
  constructor(private readonly reader: CodeReaderService) {}

  /** 把项目相对路径解析为绝对路径；不越出项目根、不存在时返回 null。 */
  private resolve(project: string, rel: string): string | null {
    const root = this.reader.resolveProject(project);
    if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) return null;
    const clean = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
    const target = path.resolve(root, clean);
    if (target !== root && !target.startsWith(root + path.sep)) return null;
    if (!fs.existsSync(target)) return null;
    return target.startsWith(root + path.sep) || target === root ? target : null;
  }

  /** 列出某项目的某个目录（相对路径）；不存在/不是目录返回 []。 */
  entries(project: string, rel = ""): ProjectEntry[] {
    const abs = this.resolve(project, rel);
    if (!abs) return [];
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      return [];
    }
    if (!st.isDirectory()) return [];
    const out: ProjectEntry[] = [];
    for (const name of fs.readdirSync(abs)) {
      const childAbs = path.join(abs, name);
      let type: "dir" | "file";
      try {
        type = fs.statSync(childAbs).isDirectory() ? "dir" : "file";
      } catch {
        continue;
      }
      if (type === "dir" && SKIP_DIRS.has(name)) continue;
      const relPath = rel ? `${rel}/${name}` : name;
      out.push({ name, type, path: type === "dir" ? `${relPath}/` : relPath });
    }
    out.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
    );
    return out;
  }

  /** 读取项目内一个文本文件；二进制或不可读返回 null。 */
  read(project: string, rel: string): ProjectFile | null {
    const abs = this.resolve(project, rel);
    if (!abs) return null;
    if (!fs.statSync(abs).isFile()) return null;
    if (fs.statSync(abs).size > MAX_FILE_BYTES) {
      return { path: rel, content: "// 文件过大（> 512KB），已拒绝读取", truncated: true };
    }
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) return null;
    return { path: rel, content: buf.toString("utf8"), truncated: false };
  }
}