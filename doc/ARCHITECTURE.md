# shishan 代码图谱 MCP —— 架构与部署设计

本文档设计一个**代码图谱 MCP**（Docker 应用）：对挂载的项目生成 `index.scip`，导入 Neo4j 图数据库，AI 通过 cypher 查询路径并渲染到 Three.js 前端；所有图数据库数据持久化在宿主机本地，不随容器回收丢失。

> 本文档是**已落地实现的架构说明**，与 `apps/backend/src/core/graph/`、`docker/scip/`、`apps/graph-app/`、`docker-compose.yml` 的实际代码保持一致。

## 1. 定位

- 是 MCP server（Streamable HTTP，复用现有 `:13000` 端点）。
- 是 Docker 应用（docker-compose 多容器编排）。
- 项目代码由宿主机**只读**、**同路径**挂载进容器（容器内路径 = 宿主机路径），数据目录同样同路径挂载（可写）。AI 传宿主机绝对路径即可直接读取，无需任何路径映射（无 `HOST_CODE_ROOT` 概念）。

## 2. 容器拓扑

```
宿主机 (Agent 项目)  ──docker compose──►
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  ┌──────────────────────────────┐                          │
│  │  mcp  (shishan-mcp:local)    │   :13000 MCP / :18080 控制台│
│  │   NestJS MCP backend          │   :18081 Three.js 图谱页  │
│  │  + nginx                      │                          │
│  │  工具: generate_scip_index / import_to_graph /           │
│  │        query_graph                                       │
│  │  挂载: <项目>:<同路径>:ro  $DATA:同路径(可写)             │
│  └───┬──────────┬────────────┬──┘                          │
│      │HTTP(8000)│Bolt(7687)  │                             │
│      ▼          ▼            ▼                              │
│  ┌──────────────────┐  ┌───────────────────┐               │
│  │ scip 网关容器     │  │ neo4j:2026-community │ :7687/7474 │
│  │ scip CLI + 各语言 │  │  BIND MOUNT       │               │
│  │ indexer(ts/py/go)│  │  $DATA/neo4j:/data │◄── 持久化关键 │
│  │ 挂载同项目:ro     │  │  $DATA/neo4j/logs  │               │
│  │ $DATA 同路径:ro   │  └───────────────────┘               │
│  └──────────────────┘                                      │
└─────────────────────────────────────────────────────────────┘
```

| 容器 | 镜像/技术 | 对外端口 | 职责 |
| --- | --- | --- | --- |
| `mcp` | 现有 NestJS + nginx | 13000 / 18080 / 18081 | MCP 编排、cypher 查询、Three.js 图谱页 |
| `scip` | 自建网关（见 §3） | 8000（仅内网） | 生成 `index.scip`，转换 protobuf → JSON |
| `neo4j` | `neo4j:2026-community` | 7687 / 7474 | 图数据库，数据绑定挂载宿主机目录 |

## 3. scip 网关容器

SCIP 是 protobuf 协议，且**每个语言一个 indexer**（Sourcegraph 官方：Go/TS/JS/Python/Java/Kotlin/Scala/Rust/Ruby/C#/C/C++ 等，约 9 种主流语言），没有"万能"单一二进制。因此 scip 单独做成一个轻量 HTTP 网关：

- 镜像内预装 `scip` CLI（`scip print` 用于 protobuf → JSON）+ 目标语言 indexer：
  - `scip-typescript`（npm，TS/JS/TSX/JSX）
  - `scip-python`（npm，Python）
  - `scip-java`（JVM fat-jar，Java/Scala/Kotlin，需项目含 Gradle/Maven 构建文件）
  - `scip-clang`（原生二进制，C/C++，需项目根有 `compile_commands.json` 编译数据库；**仅发布 x86_64-linux / arm64-darwin 资产**，arm64 Linux 容器不安装，`server.js` 会返回"未安装"）
  - `scip-go` 走 `go install`，`scip-ruby` / `scip-dotnet` 等可按需补充
- 暴露小 HTTP API：

| 端点 | 说明 |
| --- | --- |
| `POST /api/jobs` | `{project, language}` 异步触发索引任务，返回 `{jobId}` |
| `GET /api/jobs/:id` | 查询任务状态（pending/running/done/failed） |
| `GET /api/index/:project` | 返回 `index.scip` 的 JSON 表示（内部用 `scip print --json`） |
| `GET /api/health` | ok + 已安装 indexer 列表（按 `/usr/local/bin` 实际存在性过滤） |

- 代码挂载与 `mcp` 容器**完全一致**（同一批项目、同路径挂载），通过 `SCIP_PROJECTS`（冒号分隔的绝对路径列表）声明；输出写到数据目录下的 `scip/`。
- **backend 不直接碰 index.scip 文件**：`import_to_graph` 全程走网关 `GET /api/index/:project` 拿 JSON，所以 scip 容器与 mcp 容器无需共享 scip 数据卷，各自挂载同一批项目源码即可。
- **indexer 调用参数**（`server.js` 里 `indexerFor()` 按语言区分）：
  - TS/JS/TSX/JSX（`scip-typescript`）：`index --infer-tsconfig --no-global-caches`，在 cwd 产出 `index.scip`
  - Python（`scip-python`）：`index . --project-name <p>`
  - Java/Scala/Kotlin（`scip-java`）：`index`（Gradle/Maven 项目）
  - C/C++（`scip-clang`）：`--compdb-path=compile_commands.json`（项目根需有编译数据库）
  - 已知坑：`scip-python` 0.6.6 与 Python 3.9 的旧 pip 元数据不兼容（`PathDistribution` 无 `.name`），镜像里装 Python 3.11+ 可规避；`scip-clang` 没有 arm64-linux 资产，Apple Silicon 上做 `linux/arm64` 容器时 C/C++ 索引不可用。

**注意**：部分 indexer 需要项目依赖（scip-typescript 通常要 `npm install`、scip-python 要 venv），覆盖语言有限（约 9 种）。scip 无对应 indexer 的语言，`import_to_graph` 捕获读索引失败并跳过符号图。

## 4. MCP 工具集与数据流

| 工具 | 入参 | 行为 |
| --- | --- | --- |
| `generate_scip_index` | `project, language` | 调 scip 网关 `POST /api/jobs`，轮询完成后写 `$DATA/scip/<proj>/index.scip` |
| `import_to_graph` | `project` | 读 index.scip（走网关 `GET /api/index/:project` 转 JSON），UNWIND 批量写入 Neo4j（签名/引用） |
| `query_graph` | `project, cypher` | 对 Neo4j 执行 cypher，把返回的 Path/Node/Relationship 抽成 nodes/edges，**存快照**到 `$DATA/projects/<proj>/<viewId>.json`，返回视图 URL（`http://localhost:18081/#/view/<proj>/<viewId>`） |

前端渲染链路：Agent 调 `query_graph` → 后端执行 cypher → 抽取节点+边 JSON → 存快照 → Three.js 页面按 hash 路由 `#/view/<proj>/<viewId>` 加载快照渲染。

## 5. Neo4j 图模型

```
(:Project)-[:CONTAINS]->(:File)
(:File)-[:HAS_SYMBOL]->(:Symbol)         -- scip 符号声明所在文件
(:Symbol)-[:REFERENCES]->(:Symbol)       -- scip 精确引用（跨文件）
```

- `File`：`{path, filePath, projectId}`（普通索引 path+projectId，**不用 NODE KEY——Community 版不支持**）
- `Symbol`：`{name, signature, filePath, projectId}`（SCIP symbol，带语义层级）

典型查询（Agent 提供 cypher）：

```cypher
MATCH p=(a:Symbol)-[:REFERENCES*1..5]->(b:Symbol)
WHERE a.name = 'foo'
RETURN p
```

返回的 Path 在后端序列化成 nodes/edges JSON，Three.js 按 3D 渲染。

## 6. 持久化方案（核心要求）

**用 bind mount，不用 named volume**：

- neo4j 数据 → `${DATA_DIR}/neo4j:/data`（宿主机真实目录）
- 即使 `docker compose down`、`docker rm`、重建镜像，数据都留在宿主机；`down -v` 只删 named volume，**不影响 bind mount**

复用 `${DATA_DIR}` 体系（默认 `~/.shishan-data`，见 `scripts/deploy-graph.sh`），数据目录也采用**同路径挂载**（容器内路径 = 宿主机路径），新增子目录：

```
~/.shishan-data/
├── neo4j/{data,logs}   ← 图数据库（bind mount，永不丢）
├── scip/<proj>/index.scip   ← scip 网关产出
└── projects/<proj>/<viewId>.json  ← query_graph 图视图快照
```

## 7. 部署改动清单

### 7.1 docker-compose.yml 扩展为 3 services

实际 compose 已按如下落地（`docker-compose.yml`）：数据目录用**同路径挂载**（容器内路径 = 宿主机路径），项目卷由 `deploy-graph.sh` 动态生成的 override 循环注入（任意 N 个项目、只读）；`NEO4J_PASSWORD` 用 `${NEO4J_PASSWORD:?}` 强制必填、`CODE_PROJECTS`/`SCIP_PROJECTS` 用脚本去重后的 `PROJECT_LIST`（冒号分隔、单项目不会传成 `proj-a:proj-a` 重复）。

```yaml
services:
  scip:
    build: { context: ./docker/scip, dockerfile: Dockerfile }
    environment:
      - SCIP_PROJECTS=${PROJECT_LIST:?}   # 冒号分隔的项目绝对路径（脚本传去重后的 PROJECT_LIST）
      - SCIP_DATA_ROOT=${DATA_DIR}/scip
    volumes:
      - ${DATA_DIR}:${DATA_DIR}             # 项目卷：由脚本 override 注入（同路径只读）
    expose: ["8000"]
    restart: unless-stopped

  neo4j:
    image: neo4j:2026-community
    environment:
      - NEO4J_AUTH=neo4j/${NEO4J_PASSWORD}
      - NEO4J_server_memory_heap_max__size=1G
    volumes:
      - ${DATA_DIR}/neo4j/data:/data            # ← bind mount 持久化
      - ${DATA_DIR}/neo4j/logs:/logs
    ports:
      - "7474:7474"   # Neo4j Browser（调试用，可去掉）
      - "7687:7687"   # Bolt（调试用，可去掉）
    restart: unless-stopped

  shishan:
    # ... 现有配置 ...
    environment:
      - CODE_PROJECTS=${PROJECT_LIST:?}    # 同路径挂载的项目绝对路径列表（脚本传去重后的 PROJECT_LIST）
      - DATA_ROOT=${DATA_DIR}                    # 数据目录绝对路径（同路径挂载）
      - SCIP_URL=http://scip:8000
      - NEO4J_URL=bolt://neo4j:7687
      - NEO4J_USER=neo4j
      - NEO4J_PASSWORD=${NEO4J_PASSWORD}
      - GRAPH_VIEW_URL=http://localhost:18081   # query_graph 返回的 viewUrl 前缀
    volumes:
      - ${DATA_DIR}:${DATA_DIR}                  # 可写数据目录（同路径挂载）；项目卷由脚本 override 注入
    ports:
      - "18081:82"     # ← 新增：代码图谱 3D 页
    depends_on: [scip, neo4j]
```

### 7.2 Dockerfile

- backend 移除 tree-sitter 原生依赖，不再需要 node-gyp 编译链，基础镜像沿用 `node:20-slim`。
- `apps/graph-app` 构建阶段（Three.js 前端），由 nginx 托管到 `:18081`（`docker/nginx.conf` 新增 `listen 82` server block）。
- 构建阶段联网走构建代理：`docker-compose.yml` 里 `http_proxy`/`https_proxy`/`all_proxy` 作 build-arg 注入。

### 7.3 新增文件

- `docker/scip/`：`Dockerfile`（`node:20-slim` + go + python3 + JDK17(launcher) + 预装 JDK21/JDK11(清华 Temurin) + Gradle 9.6.1(腾讯镜像) + scip CLI + scip-typescript/scip-python + scip-java + scip-clang[仅 x86_64] + 国内 gradle 仓库镜像 init 脚本）+ `server.js`（无依赖 HTTP job 网关，纯 Node 标准库）。

> **Kotlin 项目已知限制**：镜像内嵌的 scip-kotlinc 基于 Kotlin 2.2.0 编译，对任何 Kotlin 2.2.x+ 项目的编译必崩（`NoSuchMethodError`，FIR 内部 API 无兼容保证）。Java / TS / Python 等不受影响。Kotlin 项目的统一解法：**升级项目 Kotlin 到 2.4.10 对齐 fork main**（保留自定义增强，走标准 `scip-java index` 流程），详见 `doc/gradle-compat-guide.md` 第 3 节。
- `scripts/deploy-graph.sh`：`--data <dir> --password <pwd> [--name <前缀>] <项目绝对路径>...`，支持任意 N 个项目（循环生成挂载 override 注入 compose）；启动后打印 4 个 Web 地址 + Neo4j + 数据目录。

## 8. 注意点

1. **scip 语言覆盖有限**（约 9 种，且部分需项目依赖）；无对应 indexer 的语言，`import_to_graph` 捕获读索引失败并跳过符号图。
2. **SCIP protobuf 解析**：走网关 `scip print --json` 转换最省事（官方 TS 绑定有 google-protobuf 兼容坑，避坑）。
3. **neo4j 密码**：用 `NEO4J_PASSWORD` 环境变量注入，不写死在代码/镜像里。
4. **挂载一致性**：scip 容器与 mcp 容器必须挂载同一批项目、同一路径（都同路径挂载），且 `CODE_PROJECTS` / `SCIP_PROJECTS` 一致，否则 index.scip 里的相对路径对不上。

## 9. 实现状态

- [x] `docker/scip/` 网关（HTTP job 服务 + scip/indexers）
- [x] backend 新工具：`generate_scip_index` / `import_to_graph` / `query_graph`
- [x] `apps/graph-app/` Three.js 3D 渲染页（:18081）
- [x] docker-compose 扩 3 services + `scripts/deploy-graph.sh`
- [x] Neo4j 图模型 + UNWIND 批量导入脚本（`neo4j.service.ts` 建普通索引，Community 兼容）

已通过端到端验证：scip-typescript 生成 index.scip 并经 `scip print --json` 导入 5 个 Symbol + 4 条 REFERENCES；`query_graph` 对路径/关系/节点三种 cypher 返回均能抽出节点与边生成视图快照。
