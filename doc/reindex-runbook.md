# 重新索引 Runbook / 排障

> 适用范围：改了 **scip-java fork**（`scip-aggregator`，聚合期直写 Neo4j）之后，需要让 okhttp
> 等挂载项目的图数据按新逻辑重建的一整套操作。**本文档是实测踩坑后固化的步骤**，核心问题都先交代原因，
> 避免「看似没跑起来」的误判。

---

## 1. 什么时候需要重索引

改了以下任一地方后，旧 Neo4j 数据不反映新逻辑，必须重索引：

- `scip-java` fork 里 **生成节点/边** 的逻辑（`GraphExtractor.java`、`GraphModel.java`、`Neo4jGraphWriter.java` 等）；
- 想要让 `CALLS` / `NEXT` / 依赖占位节点 等关系按新规则重建。

> 纯查询层改动（比如 `query-graph.tool.ts` 的 preset、前端）**不需要**重索引，只重建部署即可。

---

## 2. 完整操作流程

### ① 构建 fork 发行版（在 scip-java 仓库里）

```sh
cd /Users/ydd/github/scip-java
./gradlew :scip-java:installDist   # 产物在 scip-java/build/install/scip-java
```

### ② 重新部署，把新 fork 挂进 scip 容器

```sh
cd /Users/ydd/github/shishanMcp
./scripts/deploy-graph.sh --password 123456 \
  --scip-java /Users/ydd/github/scip-java/scip-java/build/install/scip-java \
  /Users/ydd/github/okhttp
```

### ③ 等容器就绪再触发（否则 502）

**部署刚完成时 backend/scip 还没起来，立刻触发会拿到 502。** 先确认再触发：

```sh
curl -s http://localhost:18081/api/health          # 应返回 {"status":"ok",...}
docker exec shishan-scip sh -c 'ls /app/scip-java/lib/scip-aggregator-*.jar'  # 确认挂的是新 fork
```

### ④ 触发重索引（长任务，前台会 504，正常）

```sh
curl -s -X POST http://localhost:18081/api/run/generate_scip_index \
  -H "Content-Type: application/json" \
  -d '{"project":"okhttp","language":"java"}'
```

**预期：这条 HTTP 请求会在 ~60s 后得到 `504 Gateway Time-out`——这是正常的。**
`generate_scip_index` 底层是「提交异步 job → 轮询到完成（最长 600s）」，nginx 先断开客户端，
但作业在 scip 容器里**继续在后台跑**，不要以为失败了。

### ⑤ 判断是否真正完成（别看瞬间计数）

过程是「清空旧数据（`deleteProject`）→ 重新导入」，所以 Neo4j 计数会**先跌后涨、中途停一下**，
**光看 30s 时的一次计数会误判成「没跑起来」**。判完成看两处之一：

- **进度日志**（fork 的 stdout/stderr 写在这里，不进 `docker logs`）：

  ```sh
  tail -20 /Users/ydd/.shishan-data/scip/okhttp/build.log
  # 看到 "Aggregated N/N SCIP shards (100%)" 和 "wrote code graph to Neo4j for project okhttp" 即完成
  ```

- **数据本身**（等计数稳定下来后核对新逻辑）：

  ```sh
  curl -s -u neo4j:123456 -H "Content-Type: application/json" \
    -X POST http://localhost:7474/db/neo4j/tx/commit \
    -d '{"statements":[{"statement":"MATCH (n {projectId:\"okhttp\"}) RETURN count(n)"}]}'
  # 连续两次取到相同的大致值（如 32 万级）即稳定
  ```

### ⑥ 验证新逻辑生效（用针对你改动的查询）

例如验证「运行时节点是否经 NEXT 链归档」：

```sql
MATCH (:Condition)-[:NEXT*1..8]->(n) RETURN labels(n)[0] AS k, count(*)   -- 调用 + Value 经 NEXT 链归档
MATCH (:CalledMethod)-[:CALLS]->(:Method) RETURN count(*)                -- 应约 5.6 万
```

---

## 3. 常见坑速查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 触发 `generate_scip_index` 拿到 **504** | 长任务超过 nginx 超时，作业在后台继续 | 不是失败，等 finished（见 ⑤） |
| 部署后立刻触发拿到 **502** | backend/scip 容器还没就绪 | 等 `GET /api/health` 返回 ok 再触发（见 ③） |
| Neo4j 计数 **30s 左右不涨** | deleteProject 清空→重导入中途 | 是正常阶段，看 build.log 的 "Aggregated N/N" 进度 |
| 怎么都看不到 fork 的报错 | fork stdout/stderr 写在 `$DATA/scip/<project>/build.log` | 看那个文件，不看 `docker logs` |
| 改了 fork 却不生效 | 挂载的 jar 没更新 / 验错 jar | 重新 `installDist`；类在 `lib/scip-aggregator-*.jar`，不是主 `scip-java-*.jar` |

---

## 4. 改聚合器加边/加节点的注意（batching）

`Neo4jGraphWriter` 里 **节点和边各自独立攒够 250 就刷**（`flushNodes` / `flushEdges` 分开），
`addEdge` 用 `MATCH (b) ... MERGE`，**写边时目标节点若还不存在，这条边会被静默丢弃**。

- 如果你在聚合流程里为“目标”补节点，**要让目标节点先入队、边后发**（例如在 `emitRelationships()`
  这个所有文件抽完的收尾钩子里：先 `addNode` 占位节点，再统一 `addEdge`，`flush()` 会先写节点后写边）。
- 不要在 `enterInvocation` 之类逐调用点的地方内联建“要给边当目标”的节点后再指望它一定先刷。

---

## 5. 几个有用的事实

- 数据目录：`~/.shishan-data`（可用 `--data` 覆盖）；Neo4j 数据持久在 `$DATA/neo4j`，容器回收不丢。
- 挂载项目（okhttp）只读、同路径；scip 网关注入 `NEO4J_URI/USER/PASSWORD`，fork 聚合期直写 Neo4j。
- `generate_scip_index` 的 job 是幂等的：导入前先 `deleteProject`，重跑不叠脏数据。
- 网络 / 依赖镜像问题见 `china-network-guide.md`、构建兼容见 `gradle-compat-guide.md`。
