import { Module } from "@nestjs/common";
import { McpModule, McpTransportType } from "@rekog/mcp-nest";
import { McpPrimitivesModule } from "./tools";
import { ApiModule } from "./api/api.module";

function getServerName(): string {
  return process.env.MCP_SERVER_NAME || "shishan-mcp-server";
}

function getServerVersion(): string {
  return process.env.MCP_SERVER_VERSION || "0.1.0";
}

/**
 * Root module.
 *
 * - McpModule.forRoot(...)  -> mounts the MCP server on STREAMABLE_HTTP at "/"
 *   (the exact transport LLM clients like Claude Desktop connect to).
 * - McpPrimitivesModule.forFeature(...) -> registers every @Tool class in
 *   src/tools as an MCP tool.
 * - ApiModule -> a plain REST surface (/api/*) used by the bundled web page.
 *   It calls the SAME business services the MCP tools call, so the web page
 *   and the MCP layer can never drift apart.
 */
@Module({
  imports: [
    McpModule.forRoot({
      name: getServerName(),
      version: getServerVersion(),
      transport: McpTransportType.STREAMABLE_HTTP,
      mcpEndpoint: "/",
      // 增加请求超时时间到 10 分钟，scip 索引大项目需要较长时间
      serverMutator: (server) => {
        // 覆盖默认的请求超时时间（默认 60 秒）
        const originalRequest = server.server.request.bind(server.server);
        server.server.request = async (request, options) => {
          return originalRequest(request, {
            ...options,
            timeout: 600_000, // 10 分钟
          });
        };
        return server;
      },
    }),
    McpPrimitivesModule.forFeature(getServerName()),
    ApiModule,
  ],
})
export class AppModule {}
