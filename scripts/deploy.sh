#!/usr/bin/env bash
# 多项目部署脚本：构建镜像 + 挂载多个项目 + 启动容器 + 自动清理旧容器/悬空镜像。
#
# 用法（把要读的项目根目录都传进来，宿主机绝对路径）：
#   ./scripts/deploy.sh /Users/ydd/proj-a /Users/ydd/proj-b
#
# 数据目录（存放项目产生的数据，如日志）：默认取 ~/.shishan-data（与用户名/项目路径无关，
# 所有用户通用），也可以用 --data 指定或设环境变量 SHISHAN_DATA_DIR：
#   ./scripts/deploy.sh --data /Users/ydd/shishan-data /Users/ydd/proj-a
#
# 它做五件事：
#   1. 停掉并删除旧的 shishan-mcp 容器（不会残留同名旧容器）
#   2. 构建镜像（构建阶段联网需要代理，见下方 PROXY_ARGS）
#   3. 同路径挂载：每个项目挂载到容器内同一路径（容器内路径 = 宿主机路径），
#      所以 AI 传宿主机绝对路径可直接读取，无需 HOST_CODE_ROOT 映射
#   4. 数据目录同样同路径挂载（可写），通过 CODE_PROJECTS / DATA_ROOT 传给容器，
#      启动容器（18080/13000）
#   5. docker image prune 清掉每次构建遗留的悬空镜像（旧的 image 层）
#
# 换挂载目录后再跑一次本脚本即可，不需要手动删容器/镜像。
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "用法: $0 [--data <宿主机数据目录>] <宿主机项目绝对路径> [更多项目绝对路径...]" >&2
  exit 1
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER=shishan-mcp
IMAGE=shishan-mcp:local

# 构建阶段联网用代理（Docker Hub 走代理，见 CLAUDE 摘要）。可被环境变量覆盖。
PROXY_ARGS=(
  --build-arg http_proxy=http://host.docker.internal:10808
  --build-arg https_proxy=http://host.docker.internal:10808
  --build-arg all_proxy=socks5://host.docker.internal:10808
)

# 解析 --data 标志与项目路径（--data <dir> / --data=<dir> / 环境变量 SHISHAN_DATA_DIR）
DATA_DIR="${SHISHAN_DATA_DIR:-}"
PROJECTS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --data)
      [ "$#" -lt 2 ] && { echo "用法: --data <宿主机数据目录>" >&2; exit 1; }
      DATA_DIR="$2"; shift 2;;
    --data=*)
      DATA_DIR="${1#*=}"; shift;;
    -*)
      echo "未知参数: $1" >&2; exit 1;;
    *)
      PROJECTS+=("$1"); shift;;
  esac
done
if [ "${#PROJECTS[@]}" -lt 1 ]; then
  echo "用法: $0 [--data <宿主机数据目录>] <宿主机项目绝对路径> [更多项目绝对路径...]" >&2
  exit 1
fi
set -- "${PROJECTS[@]}"

# 1) 停并删旧容器（同名容器直接替换，不会堆积）
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

# 2) 构建镜像
docker build "${PROXY_ARGS[@]}" -t "$IMAGE" "$DIR"

# 数据目录：默认 $HOME/.shishan-data（与用户名/具体项目路径无关，所有用户通用），
# 创建好供容器 app 用户写入
if [ -z "$DATA_DIR" ]; then
  DATA_DIR="${HOME}/.shishan-data"
fi
mkdir -p "$DATA_DIR"
DATA_DIR="$(cd -P "$DATA_DIR" && pwd -P)"

# 3) 同路径挂载：宿主机路径 -> 容器内同一路径（只读），数据目录同样同路径挂载（可写）
ABSP=()
MOUNTS=()
CODE_PROJECTS=""
for p in "$@"; do
  abs="$(cd -P "$p" && pwd -P)"
  ABSP+=("$abs")
  MOUNTS+=(-v "$abs:$abs:ro")
  if [ -n "$CODE_PROJECTS" ]; then CODE_PROJECTS="$CODE_PROJECTS:"; fi
  CODE_PROJECTS="$CODE_PROJECTS$abs"
done

# 4) 启动容器
docker run -d --name "$CONTAINER" \
  -p 18080:80 -p 13000:3000 \
  -e CODE_PROJECTS="$CODE_PROJECTS" \
  -e DATA_ROOT="$DATA_DIR" \
  -v "$DATA_DIR:$DATA_DIR" \
  "${MOUNTS[@]}" \
  "$IMAGE"

# 5) 清理：每次构建都会留下旧镜像层（悬空镜像），一并删掉
docker image prune -f >/dev/null 2>&1 || true

echo "已启动 $CONTAINER"
echo "数据目录: $DATA_DIR（同路径挂载，可写，存放项目产生的数据/日志）"
echo "代码挂载（只读，容器内路径 = 宿主机路径）:"
for abs in "${ABSP[@]}"; do
  echo "  $abs"
done
docker ps --filter name="$CONTAINER" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
