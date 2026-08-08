#!/usr/bin/env bash
# 代码图谱版部署：用 docker compose 一键启动 3 个服务
#   shishan-mcp（MCP + nginx + tree-sitter + Three.js 图页）
#   shishan-scip（scip 索引网关）
#   shishan-neo4j（图数据库，数据 bind mount 到宿主机）
#
# 用法：
#   ./scripts/deploy-graph.sh --data <数据目录> --password <neo4j密码> \
#       <宿主机项目绝对路径> [更多项目...]
#
# 兼容约束（与 README/deploy.sh 一致）：
#   - 同路径挂载：宿主机项目绝对路径 = 容器内路径，AI 传绝对路径直接读取
#   - 项目名 = 目录名；DATA_DIR 是唯一可写挂载点，图数据库持久化在 <DATA_DIR>/neo4j
#   - 所有服务的项目挂载、路径必须一致（shishan 用 CODE_PROJECTS，scip 用 SCIP_PROJECTS）
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "用法: $0 [--project <abs>]... [--data <dir>] [--password <pwd>] [--name <容器名前缀>]" >&2
  echo "     至少传一个宿主机项目绝对路径。" >&2
  exit 1
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${SHISHAN_DATA_DIR:-$HOME/.shishan-data}"
NEO4J_PASSWORD="${NEO4J_PASSWORD:-}"
PRE="shishan"

PROJECTS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --project) [ "$#" -lt 2 ] && { echo "--project 需要值" >&2; exit 1; }; PROJECTS+=("$2"); shift 2;;
    --data)    [ "$#" -lt 2 ] && { echo "--data 需要值" >&2; exit 1; }; DATA_DIR="$2"; shift 2;;
    --password)[ "$#" -lt 2 ] && { echo "--password 需要值" >&2; exit 1; }; NEO4J_PASSWORD="$2"; shift 2;;
    --name)    [ "$#" -lt 2 ] && { echo "--name 需要值" >&2; exit 1; }; PRE="$2"; shift 2;;
    -*) echo "未知参数: $1" >&2; exit 1;;
    *)  PROJECTS+=("$1"); shift;;
  esac
done

if [ "${#PROJECTS[@]}" -lt 1 ]; then
  echo "至少需要一个宿主机项目路径。" >&2; exit 1
fi
if [ -z "$NEO4J_PASSWORD" ]; then
  echo "缺少 Neo4j 密码（--password 或 env NEO4J_PASSWORD）" >&2; exit 1
fi

# 项目绝对路径（同路径挂载：容器内 = 宿主机路径），去重（保留顺序）
ABSP=()
for p in "${PROJECTS[@]}"; do
  a="$(cd -P "$p" && pwd -P)"
  [ "${#ABSP[@]}" -gt 0 ] && { for seen in "${ABSP[@]}"; do [ "$seen" = "$a" ] && continue 2; done; }
  ABSP+=("$a")
done
if [ "${#ABSP[@]}" -lt 1 ]; then
  echo "至少需要一个宿主机项目路径。" >&2; exit 1
fi

mkdir -p "$DATA_DIR"/neo4j/data "$DATA_DIR"/neo4j/logs "$DATA_DIR"/scip "$DATA_DIR"/ast "$DATA_DIR"/projects
DATA_DIR="$(cd -P "$DATA_DIR" && pwd -P)"

# 去重后的项目列表 -> PROJECT_LIST（CODE_PROJECTS / SCIP_PROJECTS 的唯一来源）
PROJECT_LIST="$(IFS=:; echo "${ABSP[*]}")"

echo "==> 停止旧 "${PRE}"-* 容器"
docker compose -p "$PRE" -f "$DIR/docker-compose.yml" down >/dev/null 2>&1 || true

echo "==> 构建并启动"
PB="${ABSP[1]:-${ABSP[0]}}"  # 单项目时 PROJECT_B 复用（仅用于 volume 挂载；env 用 PROJECT_LIST 已去重）
PRE="$PRE" \
  PROJECT_A="${ABSP[0]}" \
  PROJECT_B="$PB" \
  PROJECT_LIST="$PROJECT_LIST" \
  DATA_DIR="$DATA_DIR" \
  NEO4J_PASSWORD="$NEO4J_PASSWORD" \
  docker compose -p "$PRE" -f "$DIR/docker-compose.yml" up -d --build

echo ""
echo "已启动："
echo "  MCP server : http://localhost:13000/"
echo "  调试控制台 : http://localhost:18080"
echo "  代码图谱 3D: http://localhost:18081"
echo "  Neo4j      : bolt://localhost:7687 (neo4j/$NEO4J_PASSWORD)"
echo "  数据目录   : $DATA_DIR（图数据库在 $DATA_DIR/neo4j，随容器回收不丢）"
echo "  挂载项目（容器内路径 = 宿主机路径）:"
for a in "${ABSP[@]}"; do echo "    $a"; done
docker compose -p "$PRE" -f "$DIR/docker-compose.yml" ps