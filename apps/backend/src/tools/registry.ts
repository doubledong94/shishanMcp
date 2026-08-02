import type { Type } from "@nestjs/common";
import { ToolSpec, toolInputSchema } from "./tool-spec";

export interface RegisteredTool {
  cls: Type<any>;
  spec: ToolSpec;
}

/**
 * 工具自注册表：每个 *.tool.ts 文件在自己的文件里调用 registerTool()，
 * 注册与定义同处一地。MCP 上线和"可用工具"展示都只读这里，
 * 因此新增工具 = 新建一个文件，无需改 index.ts 或任何数组。
 */
export const TOOL_REGISTRY: RegisteredTool[] = [];

export function registerTool(tool: RegisteredTool): void {
  TOOL_REGISTRY.push(tool);
}

export function registeredToolClasses(): Type<any>[] {
  return TOOL_REGISTRY.map((t) => t.cls);
}

/** AI 看到的所有工具定义（调试控制台左侧用它）。 */
export function describeAllTools() {
  return TOOL_REGISTRY.map((t) => ({
    name: t.spec.name,
    description: t.spec.description,
    inputSchema: toolInputSchema(t.spec),
  }));
}
