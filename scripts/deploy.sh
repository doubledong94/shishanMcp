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
#   3. 计算这些项目的共同父目录作为 HOST_CODE_ROOT
#   4. 每个项目挂载为 /workspace/<目录名>（只读），数据目录挂载为 /data（可写），启动容器（8080/8081/3000）
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

# 计算若干绝对路径的最长公共目录前缀。
common_parent() {
  local prev=""
  local first=""
  local i=0
  for p in "$@"; do
    [ $i -eq 0 ] && first="$(cd -P "$p" && pwd -P)"
    i=$((i + 1))
  done
  prev="$first"
  local cur="$first"
  while [ -n "$cur" ] && [ "$cur" != "/" ]; do
    local ok=1
    for p in "$@"; do
      local abs="$(cd -P "$p" && pwd -P)"
      case "$abs" in
        "$cur" | "$cur/"*) ;;
        *) ok=0 ;;
      esac
    done
    if [ "$ok" -eq 1 ]; then prev="$cur"; break; fi
    cur="$(dirname "$cur")"
  done
  echo "$prev"
}

# 1) 停并删旧容器（同名容器直接替换，不会堆积）
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

# 2) 构建镜像
docker build "${PROXY_ARGS[@]}" -t "$IMAGE" "$DIR"

# 3) 共同父目录 = HOST_CODE_ROOT（AI 传宿主绝对路径时用它映射）
HOST_ROOT="$(common_parent "$@")"

# 数据目录：默认 $HOME/.shishan-data（与用户名/具体项目路径无关，所有用户通用），
# 创建好供容器 app 用户写入
if [ -z "$DATA_DIR" ]; then
  DATA_DIR="${HOME}/.shishan-data"
fi
mkdir -p "$DATA_DIR"
DATA_DIR="$(cd -P "$DATA_DIR" && pwd -P)"
# 4) 组装挂载参数并启动
#    代码挂载只读（:ro），数据挂载可写（项目产生的数据统一放 /data）
MOUNTS=()
for p in "$@"; do
  abs="$(cd -P "$p" && pwd -P)"
  name="$(basename "$abs")"
  MOUNTS+=(-v "$abs:/workspace/$name:ro")
done

docker run -d --name "$CONTAINER" \
  -p 8080:80 -p 8081:81 -p 3000:3000 \
  -e CODE_ROOT=/workspace \
  -e HOST_CODE_ROOT="$HOST_ROOT" \
  -e DATA_ROOT=/data \
  -e HOST_DATA_ROOT="$DATA_DIR" \
  -v "$DATA_DIR:/data" \
  "${MOUNTS[@]}" \
  "$IMAGE"

# 5) 清理：每次构建都会留下旧镜像层（悬空镜像），一并删掉
docker image prune -f >/dev/null 2>&1 || true

echo "已启动 $CONTAINER (HOST_CODE_ROOT=$HOST_ROOT)"
echo "数据目录: $DATA_DIR -> /data (可写，存放项目产生的数据/日志)"
echo "代码挂载（只读）:"
for p in "$@"; do
  abs="$(cd -P "$p" && pwd -P)"
  echo "  $abs -> /workspace/$(basename "$abs")"
done
docker ps --filter name="$CONTAINER" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
