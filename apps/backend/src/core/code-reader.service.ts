import { Injectable } from "@nestjs/common";
import * as path from "node:path";

/**
 * Resolves the mounted projects — the "option 1" (volume-mount) mode.
 *
 * Projects are mounted at the SAME absolute path as on the host
 * (`-v /Users/me/proj-a:/Users/me/proj-a:ro`), so the container path == host
 * path. Other services use this to map a project name to its root on disk.
 *
 * The mounted projects are listed in CODE_PROJECTS (colon-separated absolute
 * paths).
 */
@Injectable()
export class CodeReaderService {
  private readonly projects: string[];

  constructor() {
    this.projects = parseProjectList(process.env.CODE_PROJECTS);
  }

  /** 挂载的项目绝对路径列表（容器内路径 = 宿主机路径）。 */
  getProjects(): string[] {
    return [...this.projects];
  }

  /** 按项目名（目录名）查项目绝对路径；不存在返回 null。 */
  resolveProject(name: string): string | null {
    return this.projects.find((p) => path.basename(p) === name) ?? null;
  }

  /** List the mounted projects (name + absolute path). */
  listProjects(): { name: string; path: string }[] {
    return this.projects.map((p) => ({ name: path.basename(p), path: p }));
  }
}

/** 解析 CODE_PROJECTS（冒号分隔的绝对路径列表），过滤空项并去重。 */
function parseProjectList(raw: string | undefined): string[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(":")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((p) => path.resolve(p)),
    ),
  ];
}
