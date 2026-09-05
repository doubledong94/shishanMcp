# 代码图谱搜索方法设计

> 本文档定义 shishanMcp 的**搜索方法**：如何沿图上的方向查代码。搜索模型源自旧项目
> shishandaimaViewer（`src/prolog/PrologConstructor.cpp` 的 FA 正则引擎 + `base_rules.pl`），
> 覆盖其中出现的**每一种搜索类型**，并逐一给出新项目（Neo4j + cypher）的对应实现。
>
> 图模型见 `doc/GRAPH_MODEL.md`；部署方式见 `README.md`。
> 想直接用现成、可粘贴的 cypher（含实际踩坑的注意事项），见 `doc/SEARCH_QUERIES.md`（实践速查）。

---

## 1. 定位：从"图上跑正则"到"cypher 模板"

旧项目的搜索 = 在代码图上跑**正则表达式**（确定性有限自动机 FA）：每条搜索线（`line`）是一个
节点序列模式，正则字符（`node*`）绑定图上的一类节点，方向步进（`*Step`）决定沿哪条关系走。

新项目把"正则 FA"换成 **cypher 模板**：同一类"搜索意图"对应一条参数化查询。本文档逐项列出
旧搜索机制中的每一种类型，并给出新项目的等价查询。

## 2. 旧搜索引擎的分层（PrologConstructor.cpp）

| 层 | 谓词 | 作用 |
| --- | --- | --- |
| 顶层搜索 | `graph(Graph, ClassScope, Output)` | 一次搜索的入口：给定类范围和输出格式 |
| 搜索线 | `line(Line, ClassScope, [Intersection...], Output)` | 一条正则线（含若干相交点） |
| 半线 | `forwardHalfLine/backwardHalfLine(Line, ClassScope, Split, [Inter...], Output)` | 在相交点处把线切开的前/后半段 |
| FA 状态 | `forwardFa/backwardFa(...)`、`faImpl`、`faSucc`、`faDone` | 自动机状态推进 |
| 转移 | `forwardTransition/backwardTransition(Line, ClassScope, Cur, Next, RegexChar, CurPoint, CurSteps, ExpectNext, NextPoint, NextSteps, [Inter...], Output)` | **正则字符的匹配转移**：当前节点 → 按 RegexChar 匹配 → 下一节点 |
| 结束转移 | `forwardEndingTransition/backwardEndingTransition` | 线结束判定 |
| 绑定 | `resolve(ValName, Key)`、`resolveRuntime(NodeVal, ClassVal, MethodKey, RuntimeNode, Key, KeyType)`、`resolveRuntimeCheck(...)` | 把正则字符绑定到具体节点/运行时项 |

搜索返回的行（`getFaOutputList` / `getCompleteOutputList`）：
- `FaOutputList(RegexChar, MethodKey, RuntimeKey)`：每步命中的字符 + 所在方法 + 运行时项
- `CompleteOutputList(RegexChar, NodeType, NodeLabel, Key, RuntimeKey, MethodKey, ClassKey, PackageKey)`：完整行

> 结论：FA 引擎是"正则线 + 相交 + 正反向"的执行器，**不新增关系**；真正定义搜索语义的是
> 正则字符（第 4 节）和方向步进（第 3 节）。新项目保留这两层，把 FA 换成 cypher。

## 3. 方向步进（搜索沿哪些关系走）

旧项目有 4 个方向的"步进"，均有正反两向，且都带多态（Override）变体：

| 谓词 | 方向 | 图关系 | 新项目等价 |
| --- | --- | --- | --- |
| `forwardDataStep/backwardDataStep` | 数据流动 | `flow(methodKey, Src, Dst)` 里 src/dst 间跨越 step | `(:Value)-[:FLOWS]->(:Value)` |
| `forwardTimingStep/backwardTimingStep` | 时机传递 | calledMethod→step→method | `(:CalledMethod)-[:CALLS]->(:Method)`（+ ROOT/LEADS_TO 锚定方法） |
| `forwardDataOverride/backwardDataOverride` | 数据多态 | 覆写方法的参数/返回值流 | 暂用 `OVERRIDES` + 跨方法绑定组合 |
| `forwardTimingOverride/backwardTimingOverride` | 调用多态 | 抽象调用分发到实现 | `(:CalledMethod)-[:CALLS]->(:Method)` + `(:Method)-[:OVERRIDES]->(:Method)` |

调用内关联（同一调用点的实参/返回值/方法归属）：

| 谓词 | 语义 | 新项目等价 |
| --- | --- | --- |
| `calledParamToCalledReturn(Mk, CP, CR)` | 实参↔调用返回 | `(:Value{kind:CALLED_PARAM})-[:ARG_OF]->(:CalledMethod)<-[:RET_OF]-(:Value{kind:CALLED_RETURN})` |
| `calledMethodToCalledReturn(Mk, CM, CR)` | 调用点↔调用返回 | `(:CalledMethod)<-[:RET_OF]-(:Value{kind:CALLED_RETURN})` |
| `calledReturnToCalledParam(Mk, CR, CP)` | 反向 | 同上（反向遍历） |
| `calledReturnToCalledMethod(Mk, CR, CM)` | 反向 | 同上 |

> 注意：旧模型用 DataStep/TimingStep 物化中间节点做方向区分；新图把这些删掉，方向用**关系类型**
> 承载（`FLOWS`/`CALLS`），正反方向用 cypher 的关系方向表达。

## 4. 正则字符（node* 谓词）→ 图模式

正则字符 = 绑定到一类节点的模式。全部 `node*` 谓词及其新项目图模式：

| 正则字符 | 旧谓词 | 绑定 | 新项目 cypher 片段 |
| --- | --- | --- | --- |
| `Field` | `nodeFieldOf(ClassScope, Field)` | 类范围里的字段 | `MATCH (:Class{...})-[:DECLARES]->(f:Field)` |
| `Method` | `nodeMethodOf(ClassScope, Method)` | 类范围里的方法 | `MATCH (:Class{...})-[:DECLARES]->(m:Method)` |
| `Constructor` | `nodeConstructorOf(ClassScope, Ctor)` | 构造器 | `MATCH (:Class{...})-[:DECLARES]->(m:Method{isConstructor:true})` |
| `Instance` | `nodeInstanceOf(ClassScope, Class, Instance)` | 类型为 C 的字段/参数/返回 | 类型在声明属性（`Field.type`/`Value`）或 `TYPED_BY` 边 |
| `Parameter` | `nodeParameterOf(Method, Param)` | 方法形参 | `MATCH (:Method{...})-[:HAS_PARAM]->(p:Value{kind:'PARAM'})` |
| `Return` | `nodeReturnOf(Method, Return)` | 方法返回值 | 方法返回值槽：`(:Value{kind:'RETURN'})`（`RETURNS` 边） |
| `CalledMethod` | `nodeCalledMethodOf(Method, CM)` | 方法内的调用点 | `MATCH (:Method{...})-[:ROOT]->(:Condition)-[:LEADS_TO]->(:CalledMethod)` |
| `CalledParam` | `nodeCalledParameterOf(Param, CP)` | 实参槽 | `MATCH (:Value{kind:'CALLED_PARAM'})-[:ARG_OF]->(:CalledMethod)` |
| `CalledReturn` | `nodeCalledReturnOf(Return, CR)` | 返回使用槽 | `MATCH (:Value{kind:'CALLED_RETURN'})` |
| `MethodUse` | `nodeMethodUse(Method, MethodUse)` | 方法调用了谁 | 经 `CalledMethod-[:CALLS]->(:Method)` 推导 |
| `FieldUse` | `nodeFieldUsedBy(Method, FieldUsedBy)` | 方法用了哪些字段 | 经 `REF`/`FLOWS` 推导 |
| `MethodUsedBy` | `nodeMethodUsedBy(Method, MethodUsedBy)` | 谁调用了此方法 | `(:Method)<-[:CALLS]-(:CalledMethod)<-[:LEADS_TO]-...` |
| `SuperOf/SubOf` | `nodeSuperOf/SubOf(Super, Sub)` | 父子类 | `(:Class)-[:EXTENDS]->(:Class)`（含 `IMPLEMENTS`） |
| `Union/Intersection/Difference` | `nodeUnion/Intersection/Difference(N1,N2,N)` | 节点集合运算 | cypher `UNION` / 双 MATCH 交集 / `WHERE NOT` |

**特殊字符**（匹配结构而非声明）：

| 特殊字符 | 旧语义 | 新项目图模式                                      |
| --- | --- |---------------------------------------------|
| `Condition` | 条件分支节点 | `(:Condition)`                              |
| `Else` | else 分支入口(逻辑标记) | `(:Condition)-[:ELSE]->(:Condition{kind:'ELSE'})`(再经 NEXT 进入 else 体) |
| `Reference` | 实例引用访问成员 | `(:Value)-[:REF]->(:CalledMethod\|:Value)`  |
| `Index` | 数组访问 | `(:Value)-[:INDEX]->(:Value{kind:'INDEX'})` |
| `DataStep` / `TimingStep` | 数据/时机步进 | 已并入 `FLOWS` / `CALLS` 关系（不物化节点）             |
| `DataOverride` / `TimingOverride` | 多态步进 | `OVERRIDES` 组合                              |
| `Any` / `Literal` / `LV` / `Field` / `Parameter` / `Return` / `Method` | 匹配任意/字面量/局部变量/字段/参数/返回/方法 | 对应 `:Value` kind 与节点 label                  |

## 5. 类范围（classScope*）→ 类集合

类范围 = 限制搜索发生在哪些类的方法里。全部 `classScope*` 谓词：

| 类范围 | 旧谓词 | 新项目 cypher |
| --- | --- | --- |
| 类名 / 类名数组 | — | `MATCH (c:Class{name:$name, projectId:$project})` |
| `inPackage(P)` | — | `MATCH (c:Class{projectId:$project}) WHERE c.package STARTS WITH $p` |
| `super(C)` | `classScopeSuper(C, Super)` | `MATCH (c:Class{name:$c})-[:EXTENDS*1..]->(s:Class) RETURN s` |
| `sub(C)` | `classScopeSub(C, Sub)` | `MATCH (c:Class{name:$c})<-[:EXTENDS*1..]-(s:Class) RETURN s` |
| `usedBy(C)` | ~~`methodUseMethod/Field` 推导~~ | ❌ 已决定不实现（不建 `USES` 边） |
| `union/intersection/difference` | `classScopeUnion/Intersection/Difference` | 两个集合 cypher 组合（UNION / 交集 / NOT IN） |
| `var(A)` | `var(T)` | 前一个已定义类范围的复用 |

## 6. 相交搜索（intersections）

旧模型：一条正则线上标 1..N 个**相交点**，`line`/`halfLine`/`fa`/`transition` 都带
`[Intersection...]` 参数；搜索切分成前半线 + 相交点 + 后半线，各段独立跑再在交点合并。

新项目等价：**相交 = 多个方向匹配到同一节点**。调用点实例（`CalledMethod`/`CalledParam`/
`CalledReturn`）是天然交点枢纽：

```cypher
// 数据流到达调用实参 ∩ 数据的分形(成员引用)经实例引用到达同一调用点
MATCH (v1:Value)-[:FLOWS]->(cp:Value{kind:'CALLED_PARAM'})-[:ARG_OF]->(cm:CalledMethod)-[:CALLS]->(m:Method)
MATCH (v2:Value)-[:REF]->(cm)
RETURN cm, v1, v2
```

## 7. 正向 / 反向搜索

`forwardHalfLine` vs `backwardHalfLine`（及 fa/transition 的正反向）：沿同一方向
`FLOWS`/`CALLS` 走正反两个方向。cypher 里反向 = 关系方向反过来：

```cypher
// 正向：谁把值传给了 method 的形参
MATCH (:Value)-[:FLOWS]->(:Value{kind:'CALLED_PARAM'})-[:ARG_OF]->(:CalledMethod)-[:CALLS]->(:Method{name:$m})
// 反向：method 的返回流向了谁
MATCH (:Method{name:$m})-[:CALLS]<-[:CALLS]-(:CalledMethod)-[:ARG_OF]<-
      (cp:Value{kind:'CALLED_PARAM'})
```

## 8. 排除（exclude*）

| 谓词 | 语义 | 新项目 |
| --- | --- | --- |
| `excludePackage(Pkg)` | 跳过某包 | `WHERE c.package <> $pkg` |
| `excludeClass(Clz)` | 跳过某类 | `WHERE c.name <> $clz` |
| `excludeMethod(Method)` | 跳过某方法 | `WHERE m.name <> $method` |

## 9. 其他搜索辅助

| 谓词 | 语义 | 新项目 |
| --- | --- | --- |
| `loopMoreThanOnce(L, E)` | 元素在循环中多次出现 | cypher `count` 聚合 + `HAVING count>1` |
| ~~`classThatUseMethodAndField(MF, Class)`~~ | ~~同时使用某方法+字段的类~~ | ❌ 依赖 `USES`，随 usedBy 一并放弃 |
| `calledKey/stepKey/overrideKey` | 声明键 ↔ 调用/步进键映射 | 已由运行时节点（CalledMethod 等）直接承载，无需映射 |
| `loadStepInRuntime` / `loadRuntime` / `loadAddressable` | 按需加载 | Neo4j 全图在库，无需加载 |
| `instanceOf` | 成员的类型 | `Field.type` / `TYPED_BY` 边 |

## 10. 各维度 × 相交 的 cypher 模板（query_graph preset 对应）

> 维度命名见 §11：`时机` 指 `NEXT` 时序主轴；`calls`/`codeorder` 等 preset 名是 AI 接口标识，保留不变，下表"方向"列标注的是各 preset 在新体系下对应的维度语义。

| 方向（新体系语义） | preset | cypher 核心 |
| --- | --- | --- |
| 时机的分形（调用） | `calls` / `callers` | `(:Method)-[:ROOT]->(:Condition)-[:LEADS_TO]->(:CalledMethod)-[:CALLS]->(:Method)` |
| 数据 | `dataflow` | `(:Value)-[:FLOWS*1..6]->(:Value)` |
| 逻辑 | `controls` | `(:Value)-[:CONTROLS]->(:Condition)-[:LEADS_TO]->(:CalledMethod)` |
| 数据的分形（成员访问） | `nesting` | `(:Value)-[:REF]->(:CalledMethod)-[:CALLS]->(:Method)` |
| 相交 | 自定义双 MATCH | 两段路径汇聚于同一 `CalledMethod`/`CalledParam` |

## 11. 维度：两条主轴 + 各自分形 + 逻辑

代码维度不是 5 个平级块，而是**两条主轴**各自带一个"分形"（自相似递归的具现），外加**独立的逻辑**：

> - **时序轴**：主轴 = 时机（`NEXT`，语句按执行先后，真正的"时间"）；它的分形 = 调用（`CALLS`，一次调用把**另一段**执行时序递归内嵌进来，自相似）。
> - **数据轴**：主轴 = 数据（`FLOWS`）；它的分形 = 成员访问 / 下标（`REF`/`INDEX`，数据在结构上自相似嵌套）。
> - **逻辑**：条件树（独立维度）。
> **时机** 一词在新体系里专指 `NEXT` 时序主轴；preset 名 `calls`/`codeorder` 等是 AI 接口标识，保留不变。

两轴之间如何接续、形成可沿之搜索的闭环（数据驱动分支、分支决定哪些调用、调用把时序切进被调方法）：

```
数据 ──CONTROLS──► 逻辑 ──LEADS_TO──► 时机的分形(CALLS 调用) ──跨函数──► 时机(NEXT 主轴，在被调方法内)
时机 ──(FLOWS推导)──► 数据（被调方法内，写先于读构成数据流，回到数据轴）
```

| 步 | 语义 | 边 |
| --- | --- | --- |
| 数据 → 逻辑 | bool 表达式的值决定走哪个分支 | `(:Value)-[:CONTROLS]->(:Condition)` |
| 逻辑 → 时机的分形 | 分支决定哪些调用发生 | `(:Condition)-[:LEADS_TO]->(:CalledMethod)` |
| 时机的分形 → 时机 | 调用把被调方法的执行插入其自身的时序主轴 | `(:CalledMethod)-[:NEXT]->被调首事件 ... ->return槽-[:NEXT]->(:CalledReturn)-[:NEXT]->调用者后续` |
| 时机 → 数据 | 写先于读才可达，末写→读构成数据流 | `FLOWS`（由执行时序推导） |

**跨轴闭环查询**（从任意维度起步）：

```cypher
// 从数据出发：一个值一路影响 逻辑→调用(时机的分形)→被调方法内的时序(NEXT 主轴)→数据
MATCH p=(v:Value)-[:CONTROLS]->(c:Condition)-[:LEADS_TO]->(cm:CalledMethod)
      -[:NEXT]->(calleeFirst)-[:NEXT*1..5]->(calleeExit)-[:NEXT]->(cr:CalledReturn)-[:NEXT]->(callerNext:Value)
WHERE v.id=$dataId
RETURN p LIMIT 20
```

**数据的分形 正交性**：成员访问/下标（`REF`/`INDEX`）讲的是**结构**（哪个实例访问哪个成员、数组取哪个元素），不是**执行**（谁先谁后）。它是数据在结构层自相似递归的具现，与数据轴共用同一主轴语义，但在任意搜索节点（条件/调用点/值）上都可以与别的维度相交——即"相交搜索"的本质。

**时序轴的 may 语义**：时机→数据在实现上是独立推导（FLOWS 来自数据流分析，非 NEXT 链计算），两者一致但不互斥——`order_true/false`（指定表达式真值）与对应分支的数据流天然对得上。

### 11.1 维度 ↔ 边 汇总

**维度 = 边（关系类型），不是节点。** 节点（`Value`/`Condition`/`CalledMethod`/`Method`/`Class`）是通用端点、本身不携带维度；**同一节点类型可同时参与多个维度**——这正是「相交搜索」能在节点上汇聚的根因。旧项目曾把维度物化成中间节点（`DataStep`/`TimingStep`），新图删掉它们，把维度迁移到**边的类型 + 方向**上承载（正反方向用 cypher 关系方向表达）。

| 轴 | 维度 | 核心/骨架边 | 入口边 | 出口边 | preset |
| --- | --- | --- | --- | --- | --- |
| 时序轴 | **时机（主轴）** | 事件链 `(X)-[:NEXT]->(Y)` | `(:Condition)-[:NEXT]->(then首事件)` | 函数尾 `NEXT` 跳回调用者：`(:CalledMethod)-[:NEXT]->被调首事件…-[:NEXT]->(:CalledReturn)-[:NEXT]->调用者后续` | `codeorder` |
| 时序轴 | **时机的分形（调用）** | `(:CalledMethod)-[:CALLS]->(:Method)` | `(:Condition)-[:LEADS_TO]->(:CalledMethod)`、`(:Value)-[:ARG_OF/RET_OF]->(:CalledMethod)` | — | `calls`/`callers` |
| 数据轴 | **数据（主轴）** | `(:Value)-[:FLOWS]->(:Value)` | — | 进出调用：`(:Value)-[:ARG_OF]->(:CalledMethod)`、`(:Value)-[:RET_OF]->(:CalledMethod)` | `dataflow` |
| 数据轴 | **数据的分形（成员访问/下标）** | `(:Value)-[:REF]->(:CalledMethod\|:Value)`、`(:Value)-[:INDEX]->(:Value{kind:'INDEX'})` | — | — | `nesting` |
| — | **逻辑** | 条件树：`(:Method)-[:ROOT]->(:Condition)`、`(:Condition)-[:SUB]->(:Condition)`、`(:Condition)-[:ELSE]->(:Condition)` | `(:Value)-[:CONTROLS]->(:Condition)` | `(:Condition)-[:LEADS_TO]->(:CalledMethod)` | `controls` |

- **时机（主轴）**：核心 `NEXT` 事件链；分支入口 `Condition-[:NEXT]->(then首事件)`；跨函数时被调方法经 `CALLED_RETURN` 把时序接回调用者后续。
- **时机的分形（调用）**：核心 `CALLS`（CalledMethod→Method）。与逻辑/数据/数据的分形的接缝都在调用点——`LEADS_TO` 从条件进来，实参 `ARG_OF` / 返回 `RET_OF` 让数据进出调用，`REF` 也能引到它。是循环里被多维度汇聚的枢纽。
- **数据（主轴）**：核心 `FLOWS`（Value→Value）；进出调用靠实参/返回槽。
- **数据的分形（成员访问/下标）**：核心 `REF`（实例→成员/调用）+ `INDEX`（数组访问）。数据在结构层的自相似递归。
- **逻辑**：内部骨架是**条件树**（`ROOT` 根分支、`SUB` 分支嵌套、`ELSE` else 链）。入口 `CONTROLS`（守卫值→分支），出口 `LEADS_TO`（分支→触发调用点），据此交接到时序轴的 `CALLS`。`Condition↔Condition` 走 `SUB`/`ELSE`，不是 `CALLS`/`LEADS_TO`/`CONTROLS`/`FLOWS`。

### 11.2 维度两两相交（交点位置决定单/双 MATCH）

每条"可沿之搜索的方向"是一条**有向线**（起点→终点），这里用与边无关的短码标注，方便看位置组合：
数据 D=`FLOWS`（写→读）、逻辑 L=`CONTROLS→LEADS_TO`（守卫值→调用点）、调用分形 C=`CALLS`（调用点→被调方法，时序轴的递归展开）、时序主轴 A=`NEXT*`（最早→最晚）、成员/下标分形 R=`REF/INDEX`（实例→成员）。
> 注：CALLS 与 NEXT 在新体系下同属**时序轴**（分形 / 主轴），但作为两条可分别搜索的方向仍可各自与其他维度相交；表中"C∩A"（原"时机∩顺序"）即一次调用经 NEXT 链接进被调时序——时序轴内部"分形接主轴"。

**规律：一条线的终点/中途接上另一条的起点/中途 → 单 MATCH；两条线在交点同首或同尾 → 双 MATCH。**

| 对 | 交点 | 位置组合 | 单/双 | 查询 |
| --- | --- | --- | --- | --- |
| 数据∩逻辑 | 守卫值 v | D**尾** + L**首** | ✅单 | `(d)-[:FLOWS]->(v)-[:CONTROLS]->(c)-[:LEADS_TO]->(cm)` |
| 数据∩调用分形 | 实参槽 cp | D**尾** + C**首** | ✅单 | `(v)-[:FLOWS]->(cp)-[:ARG_OF]->(cm)-[:CALLS]->(m)` |
| 数据∩时序主轴 | 写a/读b | D 与 A **同首同尾**（两线平行共享两端） | ❌双 | `(a)-[:FLOWS]->(b), (a)-[:NEXT*1..8]->(b)` |
| 数据∩数据分形 | 值 v / 调用点 cm | v：D**尾**+R**首** ✅单<br>cm：D**尾**+R**尾** ❌双 | 分情形 | 单：`(d)-[:FLOWS]->(v)-[:REF]->(member)`<br>双：`(v1)-[:FLOWS]->(cp)-[:ARG_OF]->(cm), (v2)-[:REF]->(cm)` |
| 逻辑∩调用分形 | 调用点 cm | L**尾** + C**首** | ✅单 | `(c)-[:LEADS_TO]->(cm)-[:CALLS]->(m)` |
| 逻辑∩时序主轴 | 条件 c | L**中** + A**中** | ✅单 | `(v)-[:CONTROLS]->(c)-[:NEXT]->(next)` |
| 逻辑∩数据分形 | 调用点 cm | L**尾** + R**尾** | ❌双 | `(c)-[:LEADS_TO]->(cm), (v)-[:REF]->(cm)` |
| 时序主轴∩调用分形 | 调用点 cm | A**中** + C**首** | ✅单 | `(prev)-[:NEXT]->(cm)-[:CALLS]->(m)` |
| 调用分形∩数据分形 | 调用点 cm | R**尾** + C**首** | ✅单 | `(v)-[:REF]->(cm)-[:CALLS]->(m)`（成员访问引到调用点并入时序） |
| 时序主轴∩数据分形 | 实例 v | A**中** + R**首** | ✅单 | `(prev)-[:NEXT]->(v)-[:REF]->(member)` |

需要**双 MATCH** 的三种（交点同尾/同首汇聚）：
- `数据∩时序主轴`：两线共享写/读两端（平行验证，天然双）
- `数据∩数据分形`@调用点：数据流到实参 且 实例引用同一调用点——**双尾汇聚**（README 相交例子的图库版）
- `逻辑∩数据分形`@调用点：逻辑到调用点 且 成员引用同一调用点——**双尾汇聚**

### 11.3 未纳入各轴维度的边

各轴维度只覆盖"可沿之搜索的方向"（流动/传递），图模型里还有一批边不在其中，分两类：

**一、结构性 / 类型层次边（不承载搜索方向，是图模型的"骨架"）**

| 边 | 起点→终点 | 作用 | 用途 |
| --- | --- | --- | --- |
| `DECLARES` | `Class→Method\|:Field` | 声明成员 | 类范围：找某类的字段/方法 |
| `HAS_PARAM` | `Method→Value`（PARAM） | 方法形参 | `Parameter` 正则字符绑定 |
| `RETURNS` | `Method→Value`（RETURN） | 方法返回值 | `Return` 正则字符绑定 |
| `EXTENDS`/`IMPLEMENTS` | `Class→Class` | 继承/实现 | **类型层次/类范围**（super/sub/ancestors/descendants） |
| `OVERRIDES` | `Method→Method` | 覆写 | **多态**：时序轴/数据轴的 override 变体（`polymorphism` preset） |
| `TYPED_BY` | `Value→Class` | 成员静态类型 | 类型标注（`instanceOf`） |

**二、调用点"接头"边（服务于维度交接，本身不成维度）**

| 边 | 起点→终点 | 作用 |
| --- | --- | --- |
| `ARG_OF` | `Value`（CALLED_PARAM）→`CalledMethod` | 实参进出调用点——数据维度的接头 |
| `RET_OF` | `Value`（CALLED_RETURN）→`CalledMethod` | 返回使用进出调用点——数据维度的接头 |
| `LEADS_TO` | `Condition`→`Value`/`CalledMethod` | 统一锚定边：把运行时 Value（数据作用域）与调用点锚定到其包围条件/方法根（恒发） |

> 结论：两轴维度 = 流动/传递方向（时序轴 `NEXT`/`CALLS`、数据轴 `FLOWS`/`REF`/`INDEX`）+ 独立逻辑（条件树）；
> 未纳入的或是静态结构与类型层次（`DECLARES`/`HAS_PARAM`/`RETURNS`/`EXTENDS`/`IMPLEMENTS`/`TYPED_BY`/`OVERRIDES`）——
> 为维度提供节点集合与类型信息，或是维度交接的接头/锚（`ARG_OF`/`RET_OF`/`LEADS_TO`——运行时节点的条件锚定统一走 `LEADS_TO`）。

## 12. 已实现 / 待实现对照

| 搜索类型 | 状态 |
| --- | --- |
| 调用（时机的分形）正反向 | ✅ `calls`/`callers` preset |
| 数据流动正反向 | ✅ `dataflow` preset |
| 逻辑控制 | ✅ `controls` preset |
| 成员访问 / 下标（数据的分形） | ✅ `nesting` preset + `INDEX` 边 |
| 相交搜索 | ✅ 双 MATCH 汇聚调用点 |
| 类范围（super/sub/inPackage） | ✅ `ancestors`/`descendants`/`inPackage` preset（需 param） |
| 多态 override 搜索 | ✅ `polymorphism` preset（OVERRIDES） |
| 时序主轴（时机） | ✅ `codeorder` preset（NEXT 边） |
| 时序主轴 × 逻辑配合 | ✅ `order_true`/`order_false` preset：经 CONTROLS 找条件，走 then(NEXT) / else 的 ELSE 节点再经 NEXT 链 |
| 排除（exclude*） | ⚠️ 可作为查询参数 |
| 正则 FA 引擎 | ❌ 不移植（cypher 原生支持路径模式） |
