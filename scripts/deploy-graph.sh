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
# 兼容约束（与 README 一致）：
#   - 同路径挂载：宿主机项目绝对路径 = 容器内路径，AI 传绝对路径直接读取
#   - 项目名 = 目录名；DATA_DIR 是唯一可写挂载点，图数据库持久化在 <DATA_DIR>/neo4j
#   - 所有服务的项目挂载、路径必须一致（shishan 用 CODE_PROJECTS，scip 用 SCIP_PROJECTS）
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "用法: $0 [--project <abs>]... [--data <dir>] [--password <pwd>] [--name <容器名前缀>] [--scip-java <dist>]" >&2
  echo "     至少传一个宿主机项目绝对路径。" >&2
  echo "     --scip-java <dist>：用本地编译的 scip-java 发行版（installDist 目录）替换 scip 容器内置版本" >&2
  exit 1
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${SHISHAN_DATA_DIR:-$HOME/.shishan-data}"
NEO4J_PASSWORD="${NEO4J_PASSWORD:-}"
PRE="shishan"
SCIP_JAVA_DIST=""

PROJECTS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --project) [ "$#" -lt 2 ] && { echo "--project 需要值" >&2; exit 1; }; PROJECTS+=("$2"); shift 2;;
    --data)    [ "$#" -lt 2 ] && { echo "--data 需要值" >&2; exit 1; }; DATA_DIR="$2"; shift 2;;
    --password)[ "$#" -lt 2 ] && { echo "--password 需要值" >&2; exit 1; }; NEO4J_PASSWORD="$2"; shift 2;;
    --name)    [ "$#" -lt 2 ] && { echo "--name 需要值" >&2; exit 1; }; PRE="$2"; shift 2;;
    --scip-java) [ "$#" -lt 2 ] && { echo "--scip-java 需要值" >&2; exit 1; }; SCIP_JAVA_DIST="$2"; shift 2;;
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

# Gradle 依赖缓存持久化：scip 容器把 /home/scip/.gradle 挂到 $DATA_DIR/scip/gradle-home，
# 容器重建不重复下载依赖。镜像内置的 init.d 镜像脚本会被挂载覆盖，需在宿主侧重建。
SCIP_GRADLE_HOME="$DATA_DIR/scip/gradle-home"
mkdir -p "$SCIP_GRADLE_HOME/init.d"
if [ ! -f "$SCIP_GRADLE_HOME/init.d/scip-repos.gradle" ]; then
  cp "$DIR/docker/scip/scip-repos.gradle" "$SCIP_GRADLE_HOME/init.d/scip-repos.gradle"
fi

# --scip-java 指向本地编译的 scip-java 发行版目录（gradle :scip-java:installDist 的产物），
# 运行时挂载到 scip 容器替换官方版本。校验目录存在且有可执行的 bin/scip-java。
if [ -n "$SCIP_JAVA_DIST" ]; then
  SCIP_JAVA_DIST="$(cd -P "$SCIP_JAVA_DIST" && pwd -P)"
  if [ ! -x "$SCIP_JAVA_DIST/bin/scip-java" ]; then
    echo "错误: --scip-java 目录里没有可执行的 bin/scip-java: $SCIP_JAVA_DIST" >&2
    exit 1
  fi
fi

# 去重后的项目列表 -> PROJECT_LIST（CODE_PROJECTS / SCIP_PROJECTS 的唯一来源）
PROJECT_LIST="$(IFS=:; echo "${ABSP[*]}")"

# 动态生成项目挂载 override：compose 原生不支持任意数量卷，仿照 deploy.sh 的思路，
# 循环把 N 个项目都生成「同路径只读」挂载，注入到 shishan 与 scip 两个容器的 volumes。
PROJECT_OVERRIDE="$(mktemp "${TMPDIR:-/tmp}/shishan-override-XXXXXX.yml")"
trap 'rm -f "$PROJECT_OVERRIDE"' EXIT
{
  echo "services:"
  for svc in shishan scip; do
    echo "  $svc:"
    echo "    volumes:"
    for a in "${ABSP[@]}"; do
      esc="${a//\\/\\\\}"; esc="${esc//\"/\\\"}"
      printf '      - "%s:%s:ro"\n' "$esc" "$esc"
    done
    if [ "$svc" = "scip" ] && [ -n "$SCIP_JAVA_DIST" ]; then
      esc="${SCIP_JAVA_DIST//\\/\\\\}"; esc="${esc//\"/\\\"}"
      printf '      - "%s:/app/scip-java:ro"\n' "$esc"
      esc="${DIR//\\/\\\\}"; esc="${esc//\"/\\\"}"
      printf '      - "%s/docker/scip/scip-java-wrapper:/usr/local/bin/scip-java:ro"\n' "$esc"
    fi
  done
} > "$PROJECT_OVERRIDE"

# 导出到当前 shell 环境：up/ps/down 每次重新插值 docker-compose.yml 时都能取到，
# 避免「只有 up 有变量、ps 报 required variable missing」的问题。
export PROJECT_LIST DATA_DIR NEO4J_PASSWORD
COMPOSE_F=(-f "$DIR/docker-compose.yml" -f "$PROJECT_OVERRIDE")

echo "==> 停止旧 "${PRE}"-* 容器"
docker compose -p "$PRE" "${COMPOSE_F[@]}" down >/dev/null 2>&1 || true

echo "==> 构建并启动"
docker compose -p "$PRE" "${COMPOSE_F[@]}" up -d --build

echo ""
echo "已启动："
echo "  MCP server : http://localhost:13000/"
echo "  调试控制台 : http://localhost:18080"
echo "  代码图谱 3D: http://localhost:18081"
echo "  Neo4j      : bolt://localhost:7687 (neo4j/$NEO4J_PASSWORD)"
# 用 ${VAR} 花括号 + 断行：macOS bash 3.2 在 set -u 下，变量紧跟全角字符（如（，）会误报 unbound variable
echo "  数据目录   : ${DATA_DIR}（图数据库在 ${DATA_DIR}/neo4j，随容器回收不丢）"
echo "  挂载项目（容器内路径 = 宿主机路径）:"
for a in "${ABSP[@]}"; do echo "    $a"; done
if [ -n "$SCIP_JAVA_DIST" ]; then
  echo "  scip-java : 本地发行版替换（${SCIP_JAVA_DIST}）"
fi
docker compose -p "$PRE" "${COMPOSE_F[@]}" ps