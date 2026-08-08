# 如何给 shishan MCP 添加工具

MCP 只是薄薄一层：**新增一个工具 = 在 `src/tools/` 下新建一个文件，然后重新部署**。工具文件会自注册（`registerTool`），`index.ts` 启动时自动扫描加载，你**不需要改任何注册表或数组**。

## 架构回顾

```
LLM 客户端 ──► MCP Streamable HTTP(/)
                 │
           NestJS MCP server
             ├─ src/tools/index.ts        ← 自动扫描加载 *.tool.ts（不需要你维护）
             ├─ src/tools/xxx.tool.ts     ← 你新增的 MCP 工具（一个文件搞定）
             ├─ src/tools/registry.ts     ← 自注册表（工具文件 registerTool 进去）
             └─ src/core/*.service.ts     ← 具体实现（tree-sitter、scip、Neo4j 等）
```

一个工具 = **一个 `ToolSpec`（定义 AI 看到的 name/description/parameters）+ 一个 `@Tool()` 方法 + 一行 `registerTool()`**。

## 添加一个工具（只建一个文件）

在 `apps/backend/src/tools/` 下新建 `sum.tool.ts`：

```ts
import { Injectable } from "@nestjs/common";
import { Tool } from "@rekog/mcp-nest";
import { z } from "zod";
import { CallLogService } from "../core/call-log.service";
import { ToolSpec } from "./tool-spec";
import { registerTool } from "./registry";

// 1) AI 看到的定义（name + description + 参数 schema）
export const SumToolSpec: ToolSpec = {
  name: "sum_two_numbers",
  description: "计算两个整数的和，返回结果。",
  parameters: z.object({
    a: z.number().describe("第一个整数"),
    b: z.number().describe("第二个整数"),
  }),
};

// 2) 工具类：简单逻辑直接内联；复杂逻辑注入 core/ 下的 service 调用
@Injectable()
export class SumTool {
  constructor(private readonly calls: CallLogService) {}

  @Tool({
    name: SumToolSpec.name,
    description: SumToolSpec.description,
    parameters: SumToolSpec.parameters,
  })
  async run(input: { a: number; b: number }) {
    // calls.track 记录到 18080 调试控制台（来源标 mcp）
    return this.calls.track("sum_two_numbers", "mcp", input, () => ({
      sum: input.a + input.b,
    }));
  }
}

// 3) 自注册：一行。上线 + "可用工具"展示都自动生效
registerTool({ cls: SumTool, spec: SumToolSpec });
```

然后两步收尾：

```bash
cd apps/backend && pnpm type-check          # 类型检查
cd ../.. && ./scripts/deploy.sh <你的挂载项目>  # 重建 + 重启（自动清理旧容器/镜像）
```

## 规则与约定

| 规则 | 说明 |
| --- | --- |
| 文件必须导出 `ToolSpec` 常量 | 装饰器和"可用工具"展示共用，**单一来源**，保证展示 = AI 收到的内容 |
| 文件末尾必须 `registerTool({ cls, spec })` | 否则工具不上线，也不会出现在"可用工具" |
| 简单逻辑直接内联 | 不需要额外 service |
| 复用逻辑抽到 `core/` 下的 service | 工具类构造器直接注入，例如 `GraphService`、`TreeSitterService` |
| 每个工具要 `calls.track(...)` | 否则 18080 调试控制台看不到调用记录 |
| 参数用 zod | `parameters` 用 `z.object({...})`，每个字段 `.describe()`，AI 靠这些描述决定怎么调用 |

## 验证

- 18080 调试控制台左侧"可用工具"自动出现 `sum_two_numbers`，含完整 description + inputSchema。
- `/api/tools` 与 MCP `tools/list` **字节级一致**（`tool-spec.ts` 用 SDK 同款 schema 转换保证的）。
- 调用后 18080 出现一条 `source: mcp` 的调用日志。
