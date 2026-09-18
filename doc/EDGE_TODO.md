# 边调试进度（TODO）

> 记录每条边的**调试状态**：哪些已经实测验证过、哪些还没碰。
> 数据基准：okhttp 全量索引（`deploy-graph.sh` 端到端直写 Neo4j 后的实测，2026-09-16）。
> 图模型语义见 `GRAPH_MODEL.md`，搜索语义见 `SEARCH_GUIDE.md`。
>
> **"已调试"的判据**：不是"跑了个 count 看着合理"，而是**经 `codeorder`/`nesting`/`dataflow` 等 preset
> 真正渲染出来、逐条核对过语义与不变量**。仅做过计数核对的，算未调试。

## 0. 前置：行号是 0-based

SCIP 的 `range` 原生 **0-based**，直写进 Neo4j 的 `line`/`col`/`colEnd` 全是 0-based：

- 后端 `graph.service.ts:519` / `:803` 在**API 出口**把 `line` 做 `+1` 转 1-based（`:440` 注释、`:453` 入参反向转）——**只覆盖 API，不覆盖 cypher 直查**。
- 所以用 `cypher-shell` 直接看数据时，**图的 `line=N` 对应源码第 `N+1` 行**；`col` 恒 0-based（`:790` 明确保留）。
- 校验方法：`line+1` 行的第 `col` 个字符起应是该标识符本身。
  例：Method `addPathSegmentsWithBackslash` = `line 1464, col 6` → 源码 1465 行第 6 列 `addPathSegme…` ✅

`GRAPH_MODEL.md §3.3` 未写明这一点，**建议补上**（否则按 1-based 手查会得到"行号错了"的误判）。

---

## 1. 已调试的边（6 种）—— 只这部分研究存在的问题

这 6 种就是 `codeorder` / `order_true` / `order_false` 画出来的全套，都经过实际渲染 + 逐条核对。

| 边 | 实测条数 | 描了什么 |
| --- | ---: | --- |
| `NEXT` | 265,561 | 执行先后（单方法体内） |
| `FLOWS` | 85,546 | 值怎么合成（写→读） |
| `REF` | 44,026 | 哪个实例访问哪个成员 |
| `CONTROLS` | 3,184 | 哪个值决定走哪个分支 |
| `PARAM_TO_METHOD` | 52,995 | 实参 → 调用点 |
| `METHOD_TO_RETURN` | 58,843 | 调用点 → 返回值 |

### 1.1 `NEXT` 的分叉不变量不成立（文档说"恒 2"）

`GRAPH_MODEL.md §3.2` 声明"if 条件节点的 NEXT 出边恒为 2（1 真 + 1 假），不多不少"。**实测不成立**：

| 条件 | 出边=1 | =2 | =3 |
| --- | ---: | ---: | ---: |
| `IF`（2616 个） | **521** | 1876 | **194** |
| `LOOP`（579 个） | **164** | 415 | 0 |

#### (a) IF 出边=1（521 个）：`if` 作**表达式**

源码形如 `val notAfter = if (notAfter != -1L) notAfter else notBefore + DURATION`。
其中 **125 个源码确实含 `else`**。实测（`HeldCertificate.kt:434`，源 435）：

```
Condition(IF, col21) ──CONTROLS──< OPERATOR(!=, col34) ──FLOWS──< notAfter(col25) + 1L(col38)
Condition(IF) ──NEXT(branch=NULL)──> notAfter(col42)   ← 真值
                                      notBefore(col56)  ← 假值，无 NEXT 入边
```

**判读**：`if` 表达式不构成控制流分叉——它是个**值**。分叉由数据流承载（真/假两个值 FLOWS 汇聚到赋值目标），`NEXT` 只表达"守卫求值后进入真值求值"。
**结论**：不是 bug，但文档"恒 2"是**错的**，须改成实测口径（"语句级 if 恒 2；表达式级 if 出边=1"）。

#### (b) IF 出边=3（194 个）：`when` 多分支

实测（`CacheStrategy.kt:304`，源 305 `when (response.code) {`，11 个常量分支）：

```
Condition(IF) ──NEXT(branch="false")──> Condition(IF, 下一个分支)   ← 假路径
              ──NEXT(branch="true")───> 分支体首事件
              ──NEXT(branch=NULL)─────> 常量值(HTTP_MOVED_TEMP)     ← 第 3 条
```

**判读**：`when` 的多个常量分支被**归并到同一个 IF**，出边数 = 1(真) + 1(假,指下一分支条件) + N(常量求值)。
**结论**：`GRAPH_MODEL.md §4.4` 说 when"类 if-else-if"，但没量化出边数，实测口径是 **1 + 1 + 分支常量数**。要么改文档，要么把常量求值边从 NEXT 里挪走。

#### (c) LOOP 出边=1（164 个）：循环体是方法最后一段

实测（`dns/MemoryCache.kt:120`，源 121 `for ((_, entry) in entriesToEvict) {`，该 for 是方法末句）：

```
LOOP(120) ──NEXT(branch="true")──> 循环体首事件(120)
          （无 branch="false" 出边）
```

对照同文件 `:98` 的 for（后面还有语句）：

```
LOOP(98) ──NEXT(true)──> 体首(99)
         ──NEXT(false)─> 后续事件(120)
```

**判读**：循环在方法末尾时没有 fall-through 事件可指，故只有真边。
**结论**：与 `§3.2` 的"叶终端"规则一致（"循环体尾回边成环"但无后继），文档 §4.2 写"条件恒 2（真→体/假→退出）"，**"退出"这一半会消失**，须补例外。

### 1.2 `CONTROLS` 守卫缺失：运算符守卫覆盖不全

`IF` 有 **74** 个 0 守卫、`LOOP` 有 **17** 个。拆开看是**两类不同原因**：

#### (a) 类型判断（58/73）—— 守卫值**根本没物化**

源码形如 `is Inet4Address -> …`、`if (thrown is InterruptedException)`、`if (this is QueueDispatcher)`。
实测（`FakeDns.kt:279`，源 280 `is Inet4Address -> …`）：

```
Condition(IF, col14)  ← 该行只有它，没有任何 Value 代表类型名 Inet4Address
```

**判读**：类型判断的守卫是**类型本身**（`Inet4Address`），当前索引不把它物化为 Value 节点，于是 CONTROLS 无处可连。
**结论**：设计缺口。`CONTROLS` 的语义在类型判断上撑不起来，需定：要么物化类型守卫节点，要么文档声明"类型判断无守卫"。

#### (b) 运算符守卫（15 个）—— 节点在，边没建

实测（`Http2ExchangeCodec.kt:206`，源 207 `if (statusLine == null) throw …`）：

```
Value(OPERATOR "==", col21)  ←→ 只有 FLOWS 入边（statusLine、null）
                              ✗ 0 条 CONTROLS 出边 → Condition(IF, col6)
```

**全库运算符守卫覆盖率**（这是重点）：

| 运算符 | 总数 | 有 CONTROLS | 覆盖率 |
| --- | ---: | ---: | ---: |
| `==` | 931 | 350 | **38%** |
| `!=` | 664 | 447 | 67% |
| `&&` | 427 | 194 | **45%** |
| `<` | 159 | 108 | 68% |

**结论**：**运算符作为守卫时，CONTROLS 边大量漏建**（`==` 只有 38%）。`codeorder` 单方法体里可能看不出来（漏的那部分恰好不在所选方法内），但这是实打实的缺口。

#### (c) `when` 多分支的守卫数不统一

`CacheStrategy.kt:304` 一个 IF 挂了 **11 个**守卫（11 个常量分支全指向同一个 IF）。
其余 IF 是 1 守卫 : 1 条件。**同一个结构（when）有两种守卫形态**，需统一。

#### (d) `TRY` 的 catch 走 NEXT 边属性（未调试）

`TRY` 348 个 / `FINALLY` 61 个 0 守卫属**预期**（结构性节点）。
但 catch 是靠 NEXT 边上的 `exception=<异常类型>` 属性表达（**239 条**），这条属性路径**从未调试过**——`codeorder` 的 `MATCH (a)-[r:NEXT|...]->(b)` 会把边带出来，但前端是否用 `exception` 渲染未知。

### 1.3 `REF` 方向语义：一条边兼两种方向

度不变式成立（出度>1 的节点 **0** 个、入度>1 的节点 **0** 个），但**方向不是单向的**：

| 场景 | 边的方向 | access |
| --- | --- | --- |
| 读 `currentThread.name`（源 235） | `base → member` | 两端 `read` |
| 写 `currentThread.name = name`（源 236） | `member → base` | 两端 `write` |

实测（`-UtilJvm.kt:234`，源 235）：

```
FIELD("name", col16, access=write) ──REF──> LOCAL_VAR("currentThread", col2, access=write)
```

**判读**：方向由 `access` 承载（`markUnreadReturn` 的 member→base 翻转），与文档"写穿引用"一致。
**结论**：README/文档若说"REF 恒指 member"会误导——**写场景方向是反的**，须写明。

#### 可疑点：跨 kind 的 REF（需逐类核对）

`Value→Value` 的 9,208 条里：

| 源 kind | 目标 kind | 条数 | 疑点 |
| --- | ---: | --- | --- |
| `LOCAL_VAR/FIELD/PARAM` | `FIELD` | 7,269 | 正常（读写成员） |
| **`LITERAL`** | `FIELD` | **971** | ⚠️ 见下 |
| **`FIELD`** | `LOCAL_VAR` | **205** | 写方向，正常 |
| `PARAM` | `LOCAL_VAR` | 15 | ⚠️ 待核 |
| `LOCAL_VAR` | `LOCAL_VAR` | 4 | ⚠️ 两个局部变量之间有 REF？待核 |
| `FIELD` | `CALLED_RETURN` | 4 | ⚠️ 待核 |

**`LITERAL → FIELD` 971 条的成员名分布**：

| 成员名 | 条数 |
| --- | ---: |
| `code` | 444 |
| `java` | 219 |
| `µs` / `ms` / `seconds` | 93 / 67 / 65 |

- `'A'.code`（`MockWebServerTest.kt:269`）→ **语义正确**（字面量访问扩展属性）。
- `Long::class.java`（`EventListenerTest.kt:644`）→ `java` 219 条**可疑**：`::class.java` 是类引用取 `.java`，把 `Long::class` 当字面量源头存疑。
- `µs`/`ms`/`seconds` → `Duration` 的**扩展属性**，同理。

**结论**：`code` 一类正确；`java` 与 Duration 扩展属性这 ~377 条需逐类核对"字面量真的能访问这个成员吗"。

### 1.4 `PARAM_TO_METHOD` / `METHOD_TO_RETURN`

覆盖率 100%（无出边的 `CALLED_PARAM` = 0，无入边的 `CALLED_RETURN` = 0），本轮**未发现新问题**。

### 1.5 `FLOWS`

本轮未深挖，未发现新问题。

---

## 2. 未调试的边 —— 只列名字与含义

以下边**从未渲染核对过**，仅列出其含义，不展开问题。

### 2.1 已声明、有数据的（5 条）

| 边 | 条数 | 含义 |
| --- | ---: | --- |
| `(:CalledMethod)-[:CALLS]->(:Method)` | 58,809 | 调用点解析到被调方法声明 |
| `(:Class)-[:DECLARES]->(:Method\|:Field)` | 8,952 | 类声明成员 |
| `(:Method)-[:HAS_PARAM]->(:Value)` | 4,032 | 方法形参 |
| `(:Method)-[:OVERRIDES]->(:Method)` | 685 | 覆写 |
| `(:Class)-[:EXTENDS]->(:Class)` | 262 | 继承（接口实现也并入此边） |

### 2.2 已声明、实测 0 条（4 条）

| 边 | 含义 |
| --- | --- |
| `IMPLEMENTS` | 接口实现（**设计上并入 `EXTENDS`**，常量留着会误导） |
| `ROOT` / `SUB` / `ELSE` | 旧的分支结构边，**已被 `NEXT` 取代** |
| `LEADS_TO` | 旧边，已被取代 |

### 2.3 文档提到、未实现（4 条）

| 边 | 含义 |
| --- | --- |
| `RETURNS`（`:Method`→`:Value`） | 方法返回值 |
| `TYPED_BY`（`:Value`→`:Class`） | 成员类型（改用属性 `Field.type`/`Value.kind`） |
| `USES` | 方法使用了谁（已决定不实现） |
| `INDEX`（`:Value`→`:Value{kind:'INDEX'}`） | 数组/集合下标访问 |

### 2.4 边之外的已知缺口（不在"边"范畴，仅记录）

- **孤立节点约 6,600 个**：`LITERAL` 2,605 / `PARAM` 2,061 / `Method` 1,041 / `FIELD` 536 / `Class` 339 等（用户先前说"以后再说"）。
- **34 个 `CalledMethod` 无 `CALLS` 出边**：`symbol` 全是 `local N`，位置指向 Kotlin 链式调用的中间行。
- **preset 层**：`intersection` 返回裸节点对 → 后端提不出边 → **画出来 0 边**（cypher 需改成 `MATCH p=… RETURN p`）；`polymorphism` 带 `file` 时返回 0；`descendants(OkHttpClient)` 返回 0。
- **索引产物 vs 仓库源码**：okhttp 工作树 HEAD 领先索引数个 commit（`git status` 干净），抽查的"行号差 1"即源于此 —— **核对源码时必须按 0-based 换算**（见 §0）。

---

## 3. preset 覆盖现状

`codeorder` / `order_true` / `order_false` 共用 `bodyTail()`（`apps/backend/src/tools/query-graph.tool.ts:61`），画 **6 种边**：

```
NEXT | FLOWS | REF | CONTROLS | PARAM_TO_METHOD | METHOD_TO_RETURN
```

去重规则：`NEXT` 让位 `FLOWS`/`REF`；`CONTROLS`/`PARAM_TO_METHOD`/`METHOD_TO_RETURN` 与 `NEXT` 共存。
`REF`/`CONTROLS`/两条接头边只保留**两端都在 body 内**的边。

`INDEX` 与全部声明层边尚未纳入任何 preset。
