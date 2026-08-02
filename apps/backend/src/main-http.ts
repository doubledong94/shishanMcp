import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(new Logger());
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "0.0.0.0";

  await app.listen(port, host);

  console.log("\n=====================================================");
  console.log(`  shishan MCP server:  http://${host}:${port}`);
  console.log(`  MCP Streamable HTTP: http://${host}:${port}/  (LLM clients connect here)`);
  console.log(`  Web 管理页 REST:     http://${host}:${port}/api/health`);
  console.log("=====================================================\n");
}

bootstrap().catch((err) => {
  console.error("Failed to start shishan MCP server:", err);
  process.exit(1);
});
