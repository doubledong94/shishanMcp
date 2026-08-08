import * as path from "node:path";

/**
 * 从 CODE_PROJECTS（与 CodeReaderService 同源）解析已挂载项目，供工具描述
 * 动态展示给 AI，让 AI 知道 project 参数应该传什么（而不是猜"proj-a"）。
 */
export interface MountedProject {
  /** 项目名 = 目录名 */
  name: string;
  /** 宿主机绝对路径（容器内同路径） */
  abs: string;
}

export function mountedProjects(): MountedProject[] {
  const raw = process.env.CODE_PROJECTS || "";
  const seen = new Set<string>();
  const out: MountedProject[] = [];
  for (const p of raw.split(":").map((s) => s.trim()).filter(Boolean)) {
    const abs = path.resolve(p);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push({ name: path.basename(abs), abs });
  }
  return out;
}

/** 拼接 project 参数的可选值描述。未挂载项目时给出明确提示。 */
export function mountedProjectsHint(): string {
  const list = mountedProjects();
  if (list.length === 0) {
    return "（当前未挂载任何项目）";
  }
  return "必须是已挂载项目之一：" + list.map((p) => `\`${p.name}\`（${p.abs}）`).join("、");
}

/** 简洁的项目列表（用于工具 description 展示），未挂载时返回空串。 */
export function mountedProjectList(): string {
  const list = mountedProjects();
  if (list.length === 0) {
    return "（当前未挂载任何项目）";
  }
  return list.map((p) => `\`${p.name}\`（${p.abs}）`).join("、");
}
