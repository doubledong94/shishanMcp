# shishan MCP

一个**代码阅读 MCP server**：部署在 Docker 里，给 AI 提供 `read_file` 工具，让它直接读你宿主机上任意项目（一个容器可同时挂载多个项目），并把读到的文件实时展示到网页上。

- **MCP 端点**：`http://localhost:3000/`（Streamable HTTP，LLM 客户端连这里）
- **调试控制台**：`http://localhost:8080`（工具清单 + 调用日志）
- **功能页**：`http://localhost:8081`（实时展示 AI 正在读的代码）

## 安装（3 步）

### 1. 准备

- 安装 [Docker](https://docs.docker.com/get-docker/)。

部署有两种方式：**方式 A** 有源码自己构建（可自定义），**方式 B** 直接下载发布好的镜像（不用下载本项目源码）。

### 2A. 部署（有源码，自己构建）

把要读的项目目录作为参数传给部署脚本（相对/绝对路径都行，可传多个）：

```bash
./scripts/deploy.sh /path/to/proj-a /path/to/proj-b
```

脚本会：停掉并删除旧容器 → 构建镜像 → 把每个项目挂载为 `/workspace/<目录名>`（**只读**）→ 把数据目录挂载为 `/data`（**可写**，存放项目产生的数据/日志）→ 启动容器（8080/8081/3000）→ 自动清理旧的悬空镜像。

数据目录默认是 `~/.shishan-data`（与用户名/项目路径无关，所有用户通用），也可以用 `--data` 指定：

```bash
./scripts/deploy.sh --data /path/to/my-data /path/to/proj-a
```

> 想用 docker compose 也行：按 `docker-compose.yml` 里的注释设置 `PROJECT_A` / `PROJECT_B` / `HOST_CODE_ROOT` / `DATA_DIR` 后 `docker compose up --build`。

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

- **构建（2A / compose / deploy.sh）**：构建阶段内的 `apk` / `npm` / `pip` 联网走构建代理，`deploy.sh` 已默认注入 `host.docker.internal:10808`，基础镜像拉取则走你 shell 里导出的代理。
- **拉镜像（2B `docker pull`）**：需要上面导出的代理；Docker Desktop 用户也可以在 Settings → Resources → Proxies 里配置，效果更稳定。
- 代理端口 / 地址不一样的话，改 `scripts/deploy.sh` 里的 `PROXY_ARGS` 和上面的导出命令即可。

### 2B. 部署（直接用发布好的镜像，无需源码）

先拉镜像（用你发布到 GHCR / Docker Hub 的地址替换）：

```bash
docker pull ghcr.io/your-name/shishan-mcp:latest
```

然后 `docker run`，把要读的项目目录**逐个挂载**到 `/workspace/<目录名>`（**只读**），并让 `HOST_CODE_ROOT` 等于这些项目在宿主机上的**共同父目录**；再单独挂一个**可写数据目录** `/data` 存放项目产生的数据（日志等）：

```bash
docker run -d --name shishan-mcp \
  -p 8080:80 -p 8081:81 -p 3000:3000 \
  -e CODE_ROOT=/workspace \
  -e HOST_CODE_ROOT=/Users/you/projects \
  -e DATA_ROOT=/data \
  -e HOST_DATA_ROOT=/Users/you/shishan-data \
  -v /Users/you/shishan-data:/data \
  -v /Users/you/projects/proj-a:/workspace/proj-a:ro \
  -v /Users/you/projects/proj-b:/workspace/proj-b:ro \
  -v /Users/you/projects/proj-c:/workspace/proj-c:ro \
  ghcr.io/your-name/shishan-mcp:latest
```

规则（和方式 A 相同）：

- **项目目录名 = 挂载点目录名**：宿主机 `/Users/you/projects/proj-a` → 容器 `/workspace/proj-a`，两者目录名必须一致，绝对路径映射才找得到。
- `HOST_CODE_ROOT` = 这些项目的**共同父目录**（上例 `/Users/you/projects`）。项目分散在不同父目录时，取能覆盖全部的最上层目录，或只挂一个项目时直接等于项目根目录。
- **数据目录** `/data`（宿主侧 `HOST_DATA_ROOT`）是唯一可写挂载点，代码挂载都是只读的。项目产生的数据（如调用日志）写在容器内 `/data/`，即宿主机 `/Users/you/shishan-data/`，重建容器不会丢；AI 用宿主机绝对路径（`/Users/you/shishan-data/...`）通过 `read_file` 也能读回这些数据文件。
- AI 传宿主机绝对路径（如 `/Users/you/projects/proj-a/src/main.py`），MCP 自动映射到容器内对应项目。

更新挂载（加/减项目）：改一下 `-v` 和 `HOST_CODE_ROOT`，重跑 `docker run`（先 `docker rm -f shishan-mcp`）。

### 3. 让你的 AI 客户端连上它

MCP 是 **remote / Streamable HTTP** 类型，地址 `http://localhost:3000/`。

**opencode**：把下面这段加进 `~/.config/opencode/opencode.jsonc`（或项目根目录的 `opencode.jsonc`）：

```jsonc
{
  "mcp": {
    "shishan": {
      "type": "remote",
      "url": "http://localhost:3000/",
      "enabled": true
    }
  }
}
```

**Claude Code**：

```bash
claude mcp add --transport http shishan http://127.0.0.1:3000
```

**其他支持 MCP 的客户端**（Cursor、Cline 等）：在 MCP Server 配置里添加类型 `http`，URL 填 `http://localhost:3000/`。

## 使用

部署后 AI 会自动看到 `read_file` 工具：

- `read_file` 只接受**宿主机绝对路径**，例如读 `/path/to/proj-a/src/main.py`，MCP 会自动映射到容器内。传相对路径会被拒绝。
- 每次 `read_file` 调用，8081 功能页会实时显示该文件全文。

## 管理

- **添加 / 移除要读的项目**：改一下部署参数重新跑一遍即可，旧容器和悬空镜像会自动清理：

  ```bash
  ./scripts/deploy.sh /path/to/proj-a /path/to/proj-b /path/to/proj-c
  ```

  **数据不会丢**：每次重跑都重新挂载同一个数据目录 `/data`（默认 `~/.shishan-data`，或 `--data` 指定），容器里产生的日志等数据一直留在宿主机。

- **停掉服务**：`docker rm -f shishan-mcp`
- **构建需要代理吗？** `deploy.sh` 默认带上了本机代理参数（Docker Hub 不可达时用）。你的网络能直连 Docker Hub 的话，把 `scripts/deploy.sh` 里的 `PROXY_ARGS` 数组清空即可。

## 常见问题

- **工具调用成功但网页没刷新**：8081 页面每 2 秒轮询 `/api/code`，正常应实时出现。确认容器在运行：`docker ps`。
- **AI 报"相对路径不被接受"**：必须传宿主机绝对路径（见上文"使用"）。
- **改了代码需要重新构建**：`deploy.sh` 每次都重新构建镜像，改动后重跑即可。
