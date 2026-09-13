# 搜索语句速查（可直接用的 cypher）

> 本文档收集**实际操作里验证过、可直接粘贴使用**的 cypher 搜索语句，并总结每类搜索的套路与坑。
> 它是 `doc/SEARCH_GUIDE.md`（搜索方法**设计**）的实践补充：SEARCH_GUIDE 讲"为什么/怎么设计"，
> 本文讲"这条能用、去改哪几处"。
>
> 图模型（节点/边类型）见 `doc/GRAPH_MODEL.md`；改聚合器后如何重索引见 `doc/reindex-runbook.md`。

## 0. 怎么把一条 cypher 送进图谱页

任意一条下面查询，都可以通过后端执行并把结果**增量并入**当前工作图（前端 3D 页实时轮询跟随）：

```sh
# 方式一：HTTP GET（探索用，返回可渲染的 {nodes,edges}）
curl -s "http://localhost:18081/api/graph/query?project=okhttp&cypher=<URL编码的cypher>"

# 方式二：等价于 MCP query_graph 工具（POST，走 /api/run/:tool）
curl -s -X POST http://localhost:18081/api/run/query_graph \
  -H "Content-Type: application/json" \
  -d '{"project":"okhttp","cypher":"<cypher>"}'
```

`query_graph` 用 `mergeCurrent` 把结果**按节点 id / 边 key 去重累加**：节点已存在则复用、只新增没见过的边。
每次执行 `revision` +1；前端固定页每 2 秒轮询 `/api/graph/current` 跟随。

---

## 1. 从高层函数沿「调用（时机的分形）」向下展开（原始搜索句）

定位一个高层函数后，把它的整个调用链（含分支/占用）在调用（时序轴的"分形"）维度展开——**不显示 Value（数据）节点**。

```cypher
MATCH (m:Method {projectId:$project, name:'intercept'})
WHERE coalesce(m.file, m.filePath) CONTAINS 'CallServerInterceptor'
MATCH p=(m)-[:NEXT|CALLS*]->(x {projectId:$project})
WHERE NOT x:Value
RETURN p
```

- 起点 `m`：`name` + 文件过滤，精确锚定某个类里的同名方法（okhttp 有 **18 个** `intercept`，
  只给 `name` 会把它们一起锚定）。
- 变长 `[:NEXT|CALLS*]`：NEXT（Method→方法体首事件，及条件→块内运行时节点）→
  CALLS（调用点→被调方法），两种边混着走，形成"从 intercept 向外扩散的调用闭包"。
  **不写上界**——跳数取决于嵌套子表达式多少，没有稳定上界，写上界会静默漏结果。
- `NOT x:Value`：路径终点不是数据节点，所以返回的只有 `Method / CalledMethod / Condition` 三类。
- 实测（CallServerInterceptor.intercept）：`1 起点 + 17 Method + 20 CalledMethod + 12 Condition = 50 节点`
  （旧值 91 是 NEXT 链上还挂着 METHOD 根条件、且 Condition 经 NEXT 直接相连时的口径；删掉根条件假节点后
  Condition 只剩真实分支节点，故变小）。
- **无 LIMIT**：LIMIT 会在懒拉取里静默截断路径，少画的边不报错。有界性由锚定保证。

---

## 2. 函数体内「一层函数按执行时序相连」（时序主轴边搜索句）

不新建边，只沿库里已有的 `NEXT` 时序边，把 `intercept` 函数体（一层内）的相邻调用按执行时序连起来。
中间夹的 Value/Condition 已存在、仅作连通，但相邻两函数之间**不再隔其它函数调用**。

```cypher
MATCH p=(a:CalledMethod)-[:NEXT*]->(b:CalledMethod)
WHERE a.file CONTAINS 'CallServerInterceptor.kt' AND a.line<=130
  AND b.file CONTAINS 'CallServerInterceptor.kt' AND b.line<=130
  AND ALL(n IN nodes(p)[1..-1] WHERE NOT n:CalledMethod)
RETURN DISTINCT a.name+' @'+toString(a.line)+'  NEXT->  '+b.name+' @'+toString(b.line) AS step
ORDER BY step
```

- 起点 `(a:CalledMethod)` 由 `file` + `line<=130` 收窄到 47 个调用点，规模可控，故可用无界 `*`。
  但**不要 `RETURN p`**——`count`/`DISTINCT` 类返回才稳（见 `GRAPH_MODEL.md`「NEXT 流搜索的三条规则」）。
- `ALL(n IN nodes(p)[1..-1] WHERE NOT n:CalledMethod)`：抽象到"函数层"，`a→b` 之间只穿 Value/Condition，
  即 `a` 在时序链上的**下一个函数**就是 `b`。
- 一个 `a` 有多个后继 = **分支**（if/else/循环各连各的），是正当的控制流，不是漏连。
- 实测返回从 `currentTimeMillis@36` 一路到 `responseHeadersEnd@126` 的时序链。

> 局限：`NEXT` 边在绘制上是被中间 Value 拆开的（见 §5），这条只用来**列出/理解**时序，不是直接渲染的边集。

---

## 3. 函数体「完整时序链」（把 NEXT 渲染进图，含 Value 连接件）

要把 NEXT 边真正**画**进前端图，就必须让路径上的 Value 连接件成为图节点（见 §5）。
但**不能直接 `RETURN p`**——含环的 NEXT 流节点少、路径多，枚举路径会爆：

```cypher
MATCH (m:Method {projectId: $project, name:'intercept'})
WHERE m.file CONTAINS 'CallServerInterceptor'
MATCH p=(m)-[:NEXT*]->(b {projectId:$project})
WHERE b.file=m.file
UNWIND relationships(p) AS r
WITH DISTINCT r
MATCH (a)-[r]->(b2)
RETURN a, r, b2
```

- **起点是 `Method` 节点**（`Method-[:NEXT]->方法体首事件`）。不能写成自由起点 `(a)-[:NEXT*]->(b)`
  再靠 `WHERE a.file=…` 收窄——那样 Neo4j 会先扫全库节点做无界展开再过滤，实测会挂住
  （见 `GRAPH_MODEL.md`「NEXT 流搜索的三条规则」）。
- **`UNWIND relationships(p) … WITH DISTINCT r` 是这条查询的要点**：同一方法体
  `RETURN p` 实测 10s / **1.3GB**，折叠成去重边只要 2s / 309KB（393 条边）——
  画到图上两者是**同一套边**，1.3GB 里 99% 是重复边的不同走法。
- 返回边的两端节点 `a`/`r`/`b2`，前端按边渲染。**返回路径或返回裸关系都能被 `extractGraphView`
  解析出边**（`graph.service.ts` 里 `isNeo4jPath` 和 `isNeo4jRel` 两个分支都在），
  所以不需要为了出边而枚举路径。
- 实测并入后：NEXT 边 +113，Value 节点 +87（都是相邻函数之间的 `callReturn→实参槽` 连接件）。

---

## 4. 验证「一层函数是否全被 NEXT 连上」（连通性检查）

只用来确认数据，不渲染。判断 `intercept` 体内所有调用点是否同属一个 NEXT 连通体：

```cypher
MATCH (n:Value)      // 或换成任意节点
WHERE n.file CONTAINS 'CallServerInterceptor.kt' AND n.line>=31 AND n.line<=135
RETURN count(n)
```

（连通性判断也可以在拿到 §2 的相邻对列表后，客户端用并查集/连通分量统计：47 个调用点落在同一个
组件里即全连通。）

---

## 5. 核心经验 / 坑

1. **重索引后旧视图是"孤儿"，必须先清空再看**。重索引（`deleteProject` + 重建）会**换掉 Neo4j 节点的内部 id**。
   此前抓的视图快照引用的是旧 id，后跑的查询找到的是新 id 的同一批函数——两边对不上，表现为
   "原有的节点一条 NEXT 都没连上、还多出一堆‘新’节点"。修复：先 `POST /api/run/new_graph`（或前端清图）
   清掉陈旧工作图，再**在同一份库上**重跑原查询 + 时序查询，让节点/边共用同一套 id。

2. **相邻两次函数调用之间必然隔着 Value**（前一个的 `CALLED_RETURN` → 下一个的实参槽 `CALLED_PARAM`）。
   所以"两个函数被 NEXT 直接相连"在**数据上不存在**（总是 `函数→Value→函数`）；要**画**出 NEXT 边，
   Value 连接件必然成为图节点。若只想看"函数层时序"而不想堆 Value，需要前端支持**隐藏 Value 压缩视图**
   （Value 作连接件、不画上画布，NEXT 边穿过它直连两个函数）——这是前端能力，不是查询能解决的。

3. **变长路径不要写上界，也不要 `RETURN p` 枚举**（两条都改了）。
   - **不写上界**：跳数取决于嵌套子表达式多少，没有稳定上界，写上界会**静默漏结果**
     （实测同一方法 `1..40` 只到 40 个节点，无界能到 379 个，差 9 倍）。
   - **不枚举路径**：含环时节点少、路径多——一个方法体 379 个节点 → 19238 条路径
     （10s / 1.3GB）。返回**去重边**：`UNWIND relationships(p) AS r WITH DISTINCT r RETURN a, r, b`，
     同一方法体 2s / 309KB，画出来是同一套边。
   - 有界性靠**锚定**保证（`name` 收窄，同名多时再加 `file`），不靠 `LIMIT`——LIMIT 只是
     懒拉取时静默截断，少画的边不报错，比挂住更隐蔽。详见 `GRAPH_MODEL.md`「NEXT 流搜索的三条规则」。
   - 另外 `NOT x:Value` 的返回去重、`DISTINCT` + `ORDER BY` 组合在 cypher 里会因分组限制报错，
     尽量投影成标量字符串或先 `WITH` 再排序。

4. **`$project` 参数**：`query_graph`/`/api/graph/query` 会注入 `$project`（项目名）；去重的 `mergeCurrent`
   靠节点 id 稳定去重，同一节点多次查询不会重复出现。

5. **`OVERRIDES` 的反向边已修**。聚合器的 `--emit-inverse-relationships`（默认开）会给每个被覆写的
   接口方法补一条指向各实现方法的反边，是给 Sourcegraph find-references 用的补丁。它在图谱里表现为
   同名方法的 `OVERRIDES` 成对出现（实测 okhttp：1363 条里 678 对），无界 `OVERRIDES*` 会在两节点间
   来回弹而挂死（`polymorphism` 曾因此不可用）。**已在聚合器里对图模式掐掉**（`ScipAggregator.
   computeInverseReferences`），重索引后 678 对归零，`polymorphism` 无界也只 1-2s。
