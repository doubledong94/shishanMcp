# 代码图谱图模型设计与 scip-java 直写方案

> 本文档定义新项目（shishanMcp）的代码图谱**图模型**，以及 **scip-java fork 直写 Neo4j** 的接入设计。
>
> 背景：旧项目 shishandaimaViewer（antlr + prolog）的目标是用图搜索代码，但工具不合适，已弃用；新项目用 **scip-java fork + Neo4j** 重写这一目标。scip-java 是**本项目专用的图数据库索引器**（不再追求通用复用，也不再以 index.scip 文件为交付物），但连接信息通过环境变量注入，保证 fork 可独立测试。

---

## 1. 总体架构变化

```
旧链路：项目 → scip-java index → index.scip → scip print --json → backend import → Neo4j
新链路：项目 → scip-java index（聚合期）→ neo4j-java-driver → Neo4j（直写）
```

- 删除三段易损环节：`index.scip` 文件产物、`scip print --json` protobuf 转换、backend 的 `buildImportStatements` 导入逻辑
- MCP 工具从 3 个变 2 个：`generate_scip_index`（索引即入库）、`query_graph`（cypher 查询 + 3D 渲染）；`import_to_graph` 已移除
- scip 容器增加 `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` 环境变量

## 2. scip-java fork 直写设计

### 2.1 写入时机：聚合期，非编译期

`scip-java index` 分两阶段：Gradle 编译期（javac / scip-kotlinc 插件逐文件产出分片）→ 聚合期（合并全部分片、解析跨模块/外部引用）。**必须在聚合期写**：

- 编译期只有单模块分片，跨模块引用、externalSymbols 都未解析，此时写图是残缺的
- 聚合期才有完整视图：全部符号、跨文件引用、外部符号、语法树信息
- 额外收益：绕开 `.tree` sidecar 的 protobuf 递归上限 bug，以及聚合 `emitMergedTrees` 的深递归栈溢出 bug（不再需要把数百 MB 语法树落盘/读回/深递归合并）

### 2.2 连接与可测试性

连接信息全走环境变量，运行时注入：

```
NEO4J_URI       # bolt://neo4j:7687
NEO4J_USER      # neo4j
NEO4J_PASSWORD
NEO4J_DATABASE  # 可选
```

- fork 专用图库，**不做文件回退**（不再产出 index.scip 作为交付物；调试旁路可保留，非必须）
- 独立测试：起一次性 Neo4j 容器 → 指向它跑 fork → cypher 断言节点/关系 → 销毁容器。fork 对 Neo4j 的依赖是运行时注入的，不是编译期/部署期绑死

### 2.3 批处理与幂等

- UNWIND 批量 + 事务写入（1000~5000/批），真实项目百万级 occurrence，单条写入不可行
- 写入前 `DELETE` 该项目旧数据（或给节点带 importId，成功后再清旧），防重跑叠脏数据
- 节点用稳定 id + `MERGE` 去重

## 3. 图模型定稿

### 3.1 节点类型

**声明层（唯一，代表代码结构本身）：**

| 节点 | 关键属性 | 说明 |
| --- | --- | --- |
| `:Class` | `id, name, package, filePath, kind` | kind: class/interface/enum/record |
| `:Method` | `id, name, signature, filePath, line, isConstructor, returnType` | 含构造器（isConstructor） |
| `:Field` | `id, name, type, filePath, line` | 类字段 |
| `:Value`（声明形态） | `id, kind, name, type, read, write` | kind: PARAM / RETURN / LOCAL_VAR 的声明节点 |
| `:LocalVar` | `id, name, type, line` | 局部变量（可并入 :Value） |

**运行时层（每次出现一个，随调用/读取/写入产生）：**

| 节点 | 关键属性 | 说明 |
| --- | --- | --- |
| `:CalledMethod` | `id, file, line, method` | 一处调用点；同时是 ARG_OF / RET_OF 的枢纽 |
| `:Value`（运行时形态） | `id, kind, name, type, file, line, read, write` | kind ∈ FIELD / PARAM / RETURN / LOCAL_VAR / CALLED_PARAM / CALLED_RETURN / DEFAULT_VALUE / KEY_WORD_VALUE / ENUM_INSTANCE / ANONYMOUS_CLASS，对应旧 `GlobalInfo.h` 的 KEY_TYPE_* |
| `:Condition` | `id, kind, method` | 分支节点，kind: IF / ELSE_IF / ELSE / LOOP / FOR / WHILE / CATCH… |

### 3.2 关系类型

**声明层关系：**

| 关系 | 说明 | 旧 prolog |
| --- | --- | --- |
| `(:Class)-[:DECLARES]->(:Method|:Field)` | 类声明成员 | `method / constructor / field / parameter / return` |
| `(:Method)-[:HAS_PARAM]->(:Value)` | 方法形参 | `parameter(M, P)` |
| `(:Method)-[:RETURNS]->(:Value)` | 方法返回值 | `return(M, R)` |
| `(:Class)-[:EXTENDS|IMPLEMENTS]->(:Class)` | 继承/实现 | `subType(T, S)` |
| `(:Method)-[:OVERRIDES]->(:Method)` | 覆写 | `override(K, S)` |
| ~~`(:Method)-[:USES]->(:Method|:Field)`~~ | ~~方法使用了谁（类范围 usedBy 搜索用）~~ | ~~`methodUseMethod / methodUseField`~~（已决定不实现） |
| `(:Value)-[:TYPED_BY]->(:Class)` | 成员类型（可选，支撑类型遍历） | `instanceOf(K, T)` |

**运行时层关系：**

| 关系 | 说明 | 旧 prolog |
| --- | --- | --- |
| `(:Method)-[:ROOT]->(:Condition)` | 方法根分支 | 方法 conditionItem |
| `(:Condition)-[:SUB]->(:Condition)` | 分支嵌套 | super→sub condition |
| `(:Condition)-[:ELSE]->(:Condition)` | else 分支链 | Condition→Else→Condition |
| `(:Condition)-[:LEADS_TO]->(:CalledMethod)` | 分支通往的调用 | condition→calledMethod |
| `(:CalledMethod)-[:CALLS]->(:Method)` | 调用点解析到被调方法声明 | calledMethod→TimingStep→method |
| `(:Value)-[:SCOPED_BY]->(:Condition)` | 运行时节点锚定最近的包围分支 | addTimingFlow：item→conditionItem |
| `(:CalledMethod)-[:SCOPED_BY]->(:Condition)` | 同上 | 同上 |
| `(:Value)-[:ARG_OF]->(:CalledMethod)` | 实参属于哪个调用点 | calledParamToCalledReturn 等 |
| `(:Value)-[:RET_OF]->(:CalledMethod)` | 返回值使用属于哪个调用点 | 同上 |
| `(:Value)-[:FLOWS]->(:Value)` | 数据流（赋值/读写/传参/返回值） | `flow(Mk, S, D)` |
| `(:Value)-[:CONTROLS]->(:Condition)` | 条件变量守卫哪个分支 | `toConditionValue→conditionItem` |
| `(:Value)-[:REF]->(:CalledMethod)` | 嵌套方向：实例引用访问成员 | Reference |
| `(:Value|:CalledMethod|:Condition)-[:NEXT]->(...)` | 执行顺序：块内语句先后（第 5 方向） | `codeOrder(Mk, S, D)` |

### 3.3 属性

节点公共属性：`id`（稳定唯一，`MERGE` 用）、`file`、`line`。声明节点另有 `name`、`type`、`package` 等。数据流/引用的**方向语义由边类型承载**（FLOWS / REF / CONTROLS / CALLS），不再物化中间节点。

## 4. 关键设计决策与理由

| 决策 | 结论 | 理由 |
| --- | --- | --- |
| CalledMethod 独立节点 vs 属性边 | **独立节点** | 相交搜索的枢纽；多个方向（时机/数据/嵌套）汇聚到同一调用点 |
| CalledParam / CalledReturn | **保留** | 数据流进出调用的"接头"，与其他方向汇合 |
| Condition | **保留** | if/else 顺序 + 分支聚合身份是**不可压缩的分支结构**，边类型表达不了 |
| TimingStep / DataStep / Reference | **删除** | 它们承载的只是方向标签 + 边界语义 + 归并便利，全部可迁移到边类型 CALLS / FLOWS / REF |
| 方法上下文 | **不落库** | 由条件树 + 两流相交推导（见 4.1） |

### 4.1 为什么方法上下文可以不落库

跨方法的数据流必然穿过 called-instance（传参 `calledParam→param`、返回值 `return→calledReturn`），在**方法边界**处数据流和时机流天然相交于同一枢纽。方法内数据流则由 `SCOPED_BY → 条件树 → Method` 给出归属。前提：**每个运行时节点都必须 SCOPED_BY 一个分支**（旧 `addTimingFlow` 正是把全部 item 连到所在块 condition），否则远离调用边界的数据流节点无法找回方法。

## 5. 旧 prolog → Neo4j 映射

> 注：`forwardFa / transition / classScope* / node* / resolve* / line / graph` 等是旧项目正则搜索的 FA 引擎和查询时定义，**不是图数据**，不参与映射（将来变成 cypher 模板）。

### 5.1 直接成为节点属性的关系

这些事实本质是**单个实体的属性**，prolog 只能写成关系，Neo4j 天然是属性：

| prolog 事实 | 元数 | → 节点属性 |
| --- | --- | --- |
| `simpleName(Key, Name)` | 2 | `{name}` |
| `isFinal(Key)` | 1 | `{final: true}` |
| `instanceOf(Key, Type)` | 2 | `{type}`（保留 TYPED_BY 边则额外有遍历能力） |
| `typeToPlFile(TypeKey, FilePath)` | 2 | `{filePath}`（Class） |
| `package(Pkg, TypeKey)` | 2 | `{package}`（Class） |
| `runtimeKey(Mk, Key, RK, KeyType)` | 4 | 运行时节点 `{key, kind}`（KeyType→kind） |
| `isWrite(Mk, RuntimeNode)` | 2 | 运行时节点 `{written: true}` |

保持为边（实体间关系，写进属性丢遍历能力）：`method/constructor/field/parameter/return`（归属）、`subType`（继承）、`override`（覆写）、`methodUseMethod/methodUseField`（使用）。

### 5.2 多元谓词降维（三种模式）

Neo4j 只支持二元关系，n 元谓词统一用三种方式降维：

**模式 A：上下文/属性参 → 删除或属性化**
`p(Mk, A, B)` 中 Mk 只是上下文（已决定由条件树推导）→ 直接删，A、B 即二元边。

| 原事实 | 元数 | 转换 |
| --- | --- | --- |
| `flow(Mk, S, D)` | 3 | `S -[:FLOWS]-> D`（Mk 删） |
| `codeOrder(Mk, S, D)`（未启用） | 3 | `S -[:NEXT]-> D`（若启用，Mk 删） |

**模式 B：枢纽物化（hyperedges → hub node）**
"这几个属于同一次调用事件" → 建事件节点（calledMethod），各参与它连成 n 条二元边。这是保留 called-instance 节点的直接收益：

| 原事实 | 元数 | 转换 |
| --- | --- | --- |
| `calledParamToCalledReturn(Mk, CP, CR)` | 3 | `CP -[:ARG_OF]-> (calledMethod) <-[:RET_OF]- CR` |
| `calledMethodToCalledReturn(Mk, CM, CR)` | 3 | CM 即 calledMethod，`CR -[:RET_OF]-> (calledMethod)` |
| `calledReturnToCalledParam` / `calledReturnToCalledMethod` | 3 | 同上，全部隐式化为枢纽的扇入扇出 |

**模式 C：拆成"归属边 + 节点属性"**

| 原事实 | 元数 | 转换 |
| --- | --- | --- |
| `runtimeKey(Mk, Key, RK, KeyType)` | 4 | 节点 `{key, kind}` + `SCOPED_BY` 边 |
| `runtimeRead(Mk, V, RK)` / `runtimeWrite(Mk, V, RK)` | 3 | 节点 `{read, write}` 布尔属性，RK↔V 的流动由 FLOWS 承载 |

## 6. 搜索方向 → cypher 模板（草案）

> 以下为概念模板，实现时再细化。旧项目 5 个方向的语义对应关系见 `shishandaimaViewer/README.md`。

**时机传递（调用栈）：** `android.view.View` 内部的调用栈
```cypher
MATCH (m:Method)-[:ROOT]->(:Condition)-[:SUB*0..]->(c)-[:LEADS_TO]->(cm:CalledMethod)-[:CALLS]->(m2:Method)
WHERE m.name CONTAINS "View"
RETURN m, c, cm, m2
```

**数据流动：** 构造 View 时参数 context 如何被使用
```cypher
MATCH (p:Value {kind:"PARAM", name:"context"})-[:FLOWS*1..6]->(v:Value)
RETURN p, v
```

**逻辑控制：** `mViewFlags` 控制了哪些调用
```cypher
MATCH (f:Value {name:"mViewFlags"})-[:CONTROLS]->(:Condition)-[:LEADS_TO]->(cm:CalledMethod)
RETURN f, cm
```

**类嵌套：** `B.a1` 引用的对象上发起了哪些调用
```cypher
MATCH (v:Value {name:"a1"})-[:REF]->(cm:CalledMethod)-[:CALLS]->(m:Method)
RETURN v, cm, m
```

**相交搜索：** 找出将 `i1` 传入 `a1.a` 的调用（B.i1 数据流 与 B.a1 类嵌套 交于同一 calledMethod）
```cypher
MATCH (v1:Value {name:"i1"})-[:FLOWS]->(cp:Value)-[:ARG_OF]->(cm:CalledMethod)
MATCH (v2:Value {name:"a1"})-[:REF]->(cm)
RETURN cm, v1, v2
```

## 7. 独立测试方案

```
脚本：docker run 一次性 Neo4j（:7687）
     → NEO4J_URI/USER/PASSWORD 指向它，跑 scip-java index（样例项目）
     → cypher 断言：节点/关系数量、类型结构、典型查询结果
     → docker rm 销毁
```

## 8. 待办

实现状态：

- [x] scip-java fork：聚合期接入 neo4j-java-driver 直写（批处理 / MERGE / 幂等）
- [x] scip-java fork：环境变量注入连接信息（NEO4J_URI/USER/PASSWORD/DATABASE）
- [x] 独立测试脚本（`scip-java/scripts/e2e-graph-test.sh`：一次性 Neo4j + 断言）
- [x] shishanMcp：compose 给 scip 容器注入 NEO4J_* 环境变量
- [x] shishanMcp：`generate_scip_index` 返回写入统计（graph 字段）；`import_to_graph` 已移除（fork 直写为唯一入库路径，旧 SCIP-JSON 导入链删除）；`query_graph` 新增 preset 预置模板
- [x] fork：运行时值节点（每次出现一个，读写区分）+ FLOWS（赋值/末写/传参/返回）+ CONTROLS + REF + ELSE + CalledReturn
- [x] fork：分支感知数据流（分支作用域复制父态 / 并集合并 / 嵌套 / 循环反馈 / return 分支不合并 / 确定性赋值清空预写 / 反馈 happenLaterThan / 循环携带依赖 outer-only 读进反馈 / unwrittenReads 向上传播）
- [x] fork：写穿引用（reversedRef：`obj.field = x` 写目标为字段、基对象记已写）+ 字段访问 REF 边（类嵌套方向）
- [x] fork：跨方法传参绑定（calledParam→callee 形参，按声明序）、跨方法返回值绑定（callee return→calledReturn）
- [x] fork：数组访问 INDEX 边（`arr[i]`）；引用方向细化（markUnreadReturn：写目标 REF 翻转 member→base）
- [x] 全量验证：`deploy-graph.sh --scip-java <fork> okhttp` 端到端（网关 → fork → Neo4j 直写 → backend 工具可用）

> 说明：`import_to_graph` 及旧 `buildImportStatements`/`getIndexJson` 导入链已删除（fork 直写是唯一入库路径）；`/api/index/:project` 网关端点保留，供调试控制台的 SCIP 索引查看器使用。
