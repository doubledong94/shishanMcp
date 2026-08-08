import { Module } from "@nestjs/common";
import { NativePaths } from "./native-paths";
import { ToolExecutorService } from "./tool-executor.service";
import { CallLogService } from "./call-log.service";
import { CodeReaderService } from "./code-reader.service";
import { DataStoreService } from "./data-store.service";
import { GraphConfig } from "./graph/graph-config";
import { TreeSitterService } from "./graph/tree-sitter.service";
import { ScipClientService } from "./graph/scip-client.service";
import { Neo4jService } from "./graph/neo4j.service";
import { GraphService } from "./graph/graph.service";
import { ScipIndexViewerService } from "./graph/scip-index-viewer.service";
import { AstViewerService } from "./graph/ast-viewer.service";

/**
 * CoreModule provides the business logic + the native (Python/C++) executors +
 * the tool-call log + the workspace file reader.
 * Both the MCP tools and the REST API inject from here.
 */
@Module({
  providers: [
    NativePaths,
    ToolExecutorService,
    CallLogService,
    CodeReaderService,
    DataStoreService,
    GraphConfig,
    TreeSitterService,
    ScipClientService,
    Neo4jService,
    GraphService,
    ScipIndexViewerService,
    AstViewerService,
  ],
  exports: [
    NativePaths,
    ToolExecutorService,
    CallLogService,
    CodeReaderService,
    DataStoreService,
    GraphService,
    ScipIndexViewerService,
    AstViewerService,
  ],
})
export class CoreModule {}
