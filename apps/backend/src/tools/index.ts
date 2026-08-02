import { DynamicModule, Global, Module } from "@nestjs/common";
import * as fs from "node:fs";
import * as path from "node:path";
import { McpModule } from "@rekog/mcp-nest";
import { CoreModule } from "../core/core.module";
import { describeAllTools, registeredToolClasses } from "./registry";

export { describeAllTools };

/**
 * 新增 MCP 工具 = 在 src/tools/ 下新建一个 xxx.tool.ts：
 *   1. 定义并导出 ToolSpec（name/description/parameters）
 *   2. @Injectable() 类 + @Tool() 方法（转发到业务逻辑，简单逻辑可直接内联）
 *   3. 文件末尾调用 registerTool({ cls, spec }) 自注册
 * 完事——本文件会自动扫描加载所有 *.tool.ts，无需再手动注册。
 */
function loadToolFiles(): void {
  const files = fs.readdirSync(__dirname).filter((f) => f.endsWith(".tool.js"));
  for (const f of files) {
    // 副作用：执行各工具文件顶层的 registerTool()
    require(path.join(__dirname, f));
  }
}

@Global()
@Module({})
export class McpPrimitivesModule {
  static forFeature(serverName: string): DynamicModule {
    loadToolFiles();
    const providers = registeredToolClasses();
    return {
      module: McpPrimitivesModule,
      imports: [CoreModule, McpModule.forFeature(providers, serverName)],
      providers,
    };
  }
}
