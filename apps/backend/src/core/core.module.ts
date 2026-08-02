import { Module } from "@nestjs/common";
import { NativePaths } from "./native-paths";
import { ToolExecutorService } from "./tool-executor.service";
import { ToolService } from "./tool-service";
import { CallLogService } from "./call-log.service";
import { CodeReaderService } from "./code-reader.service";
import { CodeDisplayService } from "./code-display.service";
import { DataStoreService } from "./data-store.service";

/**
 * CoreModule provides the business logic + the native (Python/C++) executors +
 * the tool-call log + the workspace file reader.
 * Both the MCP tools and the REST API inject from here.
 */
@Module({
  providers: [
    NativePaths,
    ToolExecutorService,
    ToolService,
    CallLogService,
    CodeReaderService,
    CodeDisplayService,
    DataStoreService,
  ],
  exports: [
    NativePaths,
    ToolExecutorService,
    ToolService,
    CallLogService,
    CodeReaderService,
    CodeDisplayService,
    DataStoreService,
  ],
})
export class CoreModule {}
