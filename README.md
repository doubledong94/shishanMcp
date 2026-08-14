# shishan MCP

一个**代码图谱 MCP server**：部署在 Docker 里，给 AI 提供**代码图谱**能力（SCIP 精确符号图 + tree-sitter 语法树 → Neo4j 图数据库），AI 用 cypher 查询依赖路径并渲染到 3D 页面。支持在容器里同时挂载多个宿主机项目（只读）。

- **MCP 端点**：`http://localhost:13000/`（Streamable HTTP，LLM 客户端连这里）
- **调试控制台**：`http://localhost:18080`（工具清单 + 调用日志）
- **代码图谱 3D 页**：`http://localhost:18081`（cypher 查询结果的三维图渲染）

## 快速上手（30 秒预览）

```bash
# 代码图谱版：MCP + scip 网关 + Neo4j 图数据库（--password 是 Neo4j 密码，必填）
./scripts/deploy-graph.sh --password your-pass /path/to/proj-a
```

装好后把 `http://localhost:13000/` 配给你的 AI 客户端（见"让你的 AI 客户端连上它"），
然后 AI 就能 `generate_syntax_tree` / `generate_scip_index` 建索引、`query_graph` 查依赖图了。

---

## 前置要求

- **Docker**（含 `docker compose` v2 子命令，不是老版 `docker-compose`）：
  `docker compose version` 有输出即可。
- **端口可用**：默认占用 `13000 / 18080 / 18081`（代码图谱版另加 `7474 / 7687`）。
  被占用会导致启动失败，先 `lsof -i :13000` 之类排查，或改 `docker-compose.yml` 的端口映射。
- **磁盘 / 内存**：代码图谱版含 Neo4j（heap 1G），建议预留 2G+ 空闲内存、若干 GB 磁盘。
- **权限**：项目目录只读挂载、数据目录可写（默认 `~/.shishan-data`）。
  macOS 上若数据目录写入报权限错，检查该目录属主。
- **国内网络**：默认依赖 Docker Hub / 代理，见下方"国内网络"节。

---

## 安装（3 步）

### 1. 准备

- 安装 [Docker](https://docs.docker.com/get-docker/)，确认 `docker compose version` 可用。

部署有两种方式：**方式 A** 有源码自己构建（可自定义），**方式 B** 直接下载发布好的镜像（不用下载本项目源码）。

### 2A. 部署（有源码，自己构建）

代码图谱版一键脚本 `deploy-graph.sh` 会用 docker compose 构建镜像并启动 **3 个容器**（MCP + scip 索引网关 + Neo4j 图数据库）。把要分析的项目目录作为参数传给它（相对/绝对路径都行，可传多个）：

```bash
./scripts/deploy-graph.sh --password my-secret-pass /path/to/proj-a /path/to/proj-b
```

`--password` 是 Neo4j 密码，必填。脚本会：停掉并删除旧容器 → 构建镜像 → 把每个项目**同路径挂载**（宿主机绝对路径 = 容器内路径，只读）→ 把数据目录同样同路径挂载（可写，存放项目产生的数据/日志）→ 启动 3 个服务：`shishan-mcp`（MCP + 2 个网页）、`shishan-scip`（scip 索引网关，仅内网 8000）、`shishan-neo4j`（图数据库，端口 7474/7687）→ 自动清理旧的悬空镜像。启动后访问：

- MCP / 控制台 / 图谱页：13000 / 18080 / **18081**
- Neo4j Browser：`http://localhost:7474`（neo4j / 你设的密码）

**同路径挂载**意味着容器内路径和宿主机完全一致，scip / tree-sitter 直接按宿主机绝对路径读取项目文件，无需任何路径映射。

数据目录默认是 `~/.shishan-data`（与用户名/项目路径无关，所有用户通用），也可以用 `--data` 指定；图数据库数据持久化在 `$DATA_DIR/neo4j`，容器回收不丢。容器名前缀默认 `shishan`，用 `--name <前缀>` 修改：

```bash
./scripts/deploy-graph.sh --data /path/to/my-data --password my-secret-pass /path/to/proj-a
```

> `deploy-graph.sh` 本质是 docker compose 的封装：它把 N 个项目循环生成**同路径只读挂载**（compose 原生不支持任意数量卷，用脚本生成的 override 注入）。想直接用 compose 也行，compose 用环境变量（`:?` 强制必填）传参，但项目 vmount 需要自己把脚本生成的 override 一并 `-f` 传，最省事还是直接跑脚本：
>
> **用 `.env` 文件**（推荐，新建项目根目录 `.env`）：
>
> ```bash
> PROJECT_LIST=/path/to/proj-a:/path/to/proj-b   # 冒号分隔的项目绝对路径列表，必填
> DATA_DIR=$HOME/.shishan-data
> NEO4J_PASSWORD=your-pass                       # 必填
> # HTTP_PROXY=... HTTP 代理可选（国内构建用），见"国内网络"节
> ```
>
> **或直接在命令行导出**：
>
> ```bash
> export PROJECT_LIST=/path/to/proj-a:/path/to/proj-b
> export DATA_DIR=$HOME/.shishan-data NEO4J_PASSWORD=your-pass
> docker compose -f docker-compose.yml -f <deploy-graph.sh 生成的唯一 override> up --build
> ```
>
> 不设变量会直接报错（`PROJECT_LIST:?设置 PROJECT_LIST=...`），这是正常的。

#### 国内网络：访问 Docker Hub 需要代理

国内直连 Docker Hub / GHCR 经常超时。先在你的 shell 里导出代理（把端口改成你自己的代理端口）：

```bash
export http_proxy=http://127.0.0.1:10808
export https_proxy=http://127.0.0.1:10808
export all_proxy=socks5://127.0.0.1:10808

export HTTP_PROXY=http://127.0.0.1:10808
export HTTPS_PROXY=http://127.0.0.1:10808
export ALL_PROXY=socks5://127.0.0.1:10808
```

- **构建（deploy-graph.sh / compose）**：构建阶段内的 `apk` / `npm` / `pip` 联网走构建代理，compose 会把 shell 里导出的 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 作为 build args 注入（没导出就不注入，见 docker-compose.yml），基础镜像拉取则走你 shell 里导出的代理。
- **拉镜像（2B `docker pull`）**：需要上面导出的代理；Docker Desktop 用户也可以在 Settings → Resources → Proxies 里配置，效果更稳定。
- 代理端口 / 地址不一样的话，改上面的导出命令即可。

### 2B. 部署（直接用发布好的镜像，无需源码）

先拉镜像（用你发布到 GHCR / Docker Hub 的地址替换）：

```bash
docker pull ghcr.io/your-name/shishan-mcp:latest
```

然后 `docker run`，把要读的项目目录**同路径挂载**（宿主机绝对路径 = 容器内路径，**只读**），并设置 `CODE_PROJECTS`（冒号分隔的项目绝对路径列表）；再单独挂一个**可写数据目录**（同样同路径挂载）存放项目产生的数据（日志等）：

```bash
docker run -d --name shishan-mcp \
  -p 18080:80 -p 18081:82 -p 13000:3000 \
  -e CODE_PROJECTS=/Users/you/projects/proj-a:/Users/you/projects/proj-b \
  -e DATA_ROOT=/Users/you/shishan-data \
  -v /Users/you/shishan-data:/Users/you/shishan-data \
  -v /Users/you/projects/proj-a:/Users/you/projects/proj-a:ro \
  -v /Users/you/projects/proj-b:/Users/you/projects/proj-b:ro \
  -v /Users/you/projects/proj-c:/Users/you/projects/proj-c:ro \
  ghcr.io/your-name/shishan-mcp:latest
```
（18081 是代码图谱页；该场景不连 Neo4j 的话，图谱工具会提示未配置密码，其余功能不受影响。）

规则（和方式 A 相同）：

- **同路径挂载**：宿主机 `/Users/you/projects/proj-a` 挂载到容器内**同一路径** `/Users/you/projects/proj-a`（只读）。`CODE_PROJECTS` 里列出的就是这些挂载路径，项目名 = 目录名。
- **数据目录**：同样同路径挂载，是唯一可写挂载点，代码挂载都是只读的。项目产生的数据（如调用日志、图快照）写在宿主机 `/Users/you/shishan-data/`，重建容器不会丢。
- AI 传宿主机绝对路径（如 `/Users/you/projects/proj-a/src/main.py`），MCP 直接读取该路径——因为容器内路径与宿主机一致，无需任何映射。

更新挂载（加/减项目）：改一下 `-v` 和 `CODE_PROJECTS`，重跑 `docker run`（先 `docker rm -f shishan-mcp`）。

### 3. 让你的 AI 客户端连上它

MCP 是 **remote / Streamable HTTP** 类型，地址 `http://localhost:13000/`。

**opencode**：把下面这段加进 `~/.config/opencode/opencode.jsonc`（或项目根目录的 `opencode.jsonc`）：

```jsonc
{
  "mcp": {
    "shishan": {
      "type": "remote",
      "url": "http://localhost:13000/",
      "enabled": true
    }
  }
}
```

**Claude Code**：

```bash
claude mcp add --transport http shishan http://127.0.0.1:13000
```

**其他支持 MCP 的客户端**（Cursor、Cline 等）：在 MCP Server 配置里添加类型 `http`，URL 填 `http://localhost:13000/`。

## 代码图谱（可选）

部署时带上 Neo4j 密码（见上"2A. 部署"）后，AI 会额外看到 4 个图谱工具：

- `generate_scip_index(project, language)`：调 scip 索引网关生成精确符号索引
- `generate_syntax_tree(project, language?)`：用 tree-sitter（306 语言）生成语法树
- `import_to_graph(project)`：合并 SCIP 索引 + 语法树写入 Neo4j 图数据库
- `query_graph(project, cypher)`：对 Neo4j 执行 cypher，把结果渲染到 :18081 三维图页面

典型工作流（Agent 自主编排）：

```
generate_scip_index("proj-a", "typescript")  → generate_syntax_tree("proj-a")
  → import_to_graph("proj-a")
  → query_graph("proj-a", "MATCH p=(a:Symbol)-[:REFERENCES*1..5]->(b:Symbol) RETURN p")
```

- 数据持久化在宿主机 `$DATA_DIR/neo4j`（bind mount），重建/回收容器不丢。
- scip 按语言装 indexer：TS/JS、Python、Java/Scala/Kotlin（需 Gradle/Maven 项目）、C/C++（需 `compile_commands.json`）。没有对应 indexer 的语言，导入时自动降级为只建语法树子图。
- 没有 Neo4j 密码时，图谱工具会返回清晰报错。

## 验证安装

启动后逐项确认：

```bash
# 1. 容器在跑
docker ps                    # 应有 shishan-mcp（图谱版另有 shishan-scip、shishan-neo4j）

# 2. 后端健康检查（HTTP 200 = MCP 服务就绪）
curl -s http://localhost:13000/api/health

# 3. 网页可访问
open http://localhost:18080   # 控制台（工具清单 + 调用日志）
open http://localhost:18081   # 代码图谱 3D 页（需先有视图，直接开空白是正常的）
```

- 看到 `"status":"ok"` 之类的 JSON 即服务就绪；无输出/连接失败 → 看 `docker logs shishan-mcp`。
- 图谱版再加：`open http://localhost:7474`（Neo4j Browser，`neo4j` / 你设的密码）。

## 管理

- **添加 / 移除要读的项目**：改一下部署参数重新跑一遍即可，旧容器和悬空镜像会自动清理：

  ```bash
  ./scripts/deploy-graph.sh --password my-secret-pass /path/to/proj-a /path/to/proj-b /path/to/proj-c
  ```

  **数据不会丢**：每次重跑都重新挂载同一个数据目录 `/data`（默认 `~/.shishan-data`，或 `--data` 指定），容器里产生的日志等数据一直留在宿主机。

- **停掉服务**：`docker rm -f shishan-mcp`（图谱版另需 `docker rm -f shishan-scip shishan-neo4j`，或 `docker compose -p shishan down`）。
- **构建需要代理吗？** 见上文「国内网络」节：shell 导出代理后，compose 会把它作为构建代理注入。网络能直连 Docker Hub 的话不设代理即可。

## 常见问题

- **改了代码需要重新构建**：`deploy-graph.sh` 每次都 `--build` 重新构建镜像，改动后重跑即可。
- **图谱页（18081）打开是空白**：图谱页按 URL hash 加载快照，直接打开 `http://localhost:18081` 没有视图是正常的；要让 AI 先调 `query_graph` 拿到 `viewUrl`（形如 `http://localhost:18081/#/view/<proj>/<viewId>`）再打开。
- **`import_to_graph` 报"未配置 NEO4J_PASSWORD"**：用 `deploy-graph.sh --password <密码>` 部署；密码通过 compose 注入，不能缺省。
