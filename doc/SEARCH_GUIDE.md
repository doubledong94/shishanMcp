# 代码图谱搜索方法设计

> 本文档定义 shishanMcp 的**搜索方法**：如何沿图上的方向查代码。搜索模型源自旧项目
> shishandaimaViewer（`src/prolog/PrologConstructor.cpp` 的 FA 正则引擎 + `base_rules.pl`），
> 覆盖其中出现的**每一种搜索类型**，并逐一给出新项目（Neo4j + cypher）的对应实现。
>
> 图模型见 `doc/GRAPH_MODEL.md`；部署方式见 `README.md`。

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
| `forwardTimingStep/backwardTimingStep` | 时机传递 | calledMethod→step→method | `(:CalledMethod)-[:CALLS]->(:Method)`（+ ROOT/SCOPED_BY 锚定方法） |
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
| `CalledMethod` | `nodeCalledMethodOf(Method, CM)` | 方法内的调用点 | `MATCH (:Method{...})-[:ROOT]->(:Condition)<-[:SCOPED_BY]-(:CalledMethod)` |
| `CalledParam` | `nodeCalledParameterOf(Param, CP)` | 实参槽 | `MATCH (:Value{kind:'CALLED_PARAM'})-[:ARG_OF]->(:CalledMethod)` |
| `CalledReturn` | `nodeCalledReturnOf(Return, CR)` | 返回使用槽 | `MATCH (:Value{kind:'CALLED_RETURN'})` |
| `MethodUse` | `nodeMethodUse(Method, MethodUse)` | 方法调用了谁 | 经 `CalledMethod-[:CALLS]->(:Method)` 推导 |
| `FieldUse` | `nodeFieldUsedBy(Method, FieldUsedBy)` | 方法用了哪些字段 | 经 `REF`/`FLOWS` 推导 |
| `MethodUsedBy` | `nodeMethodUsedBy(Method, MethodUsedBy)` | 谁调用了此方法 | `(:Method)<-[:CALLS]-(:CalledMethod)<-[:SCOPED_BY]-...` |
| `SuperOf/SubOf` | `nodeSuperOf/SubOf(Super, Sub)` | 父子类 | `(:Class)-[:EXTENDS]->(:Class)`（含 `IMPLEMENTS`） |
| `Union/Intersection/Difference` | `nodeUnion/Intersection/Difference(N1,N2,N)` | 节点集合运算 | cypher `UNION` / 双 MATCH 交集 / `WHERE NOT` |

**特殊字符**（匹配结构而非声明）：

| 特殊字符 | 旧语义 | 新项目图模式                                      |
| --- | --- |---------------------------------------------|
| `Condition` | 条件分支节点 | `(:Condition)`                              |
| `Else` | else 分支链 | `(:Condition)-[:ELSE]->(:Condition)`        |
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
// 数据流到达调用实参 ∩ 类嵌套经实例引用到达同一调用点
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

## 10. 四方向 × 相交 的 cypher 模板（query_graph preset 对应）

| 方向 | preset | cypher 核心 |
| --- | --- | --- |
| 时机 | `calls` / `callers` | `(:Method)-[:ROOT]->(:Condition)<-[:SCOPED_BY]-(:CalledMethod)-[:CALLS]->(:Method)` |
| 数据 | `dataflow` | `(:Value)-[:FLOWS*1..6]->(:Value)` |
| 逻辑 | `controls` | `(:Value)-[:CONTROLS]->(:Condition)-[:LEADS_TO]->(:CalledMethod)` |
| 嵌套 | `nesting` | `(:Value)-[:REF]->(:CalledMethod)-[:CALLS]->(:Method)` |
| 相交 | 自定义双 MATCH | 两段路径汇聚于同一 `CalledMethod`/`CalledParam` |

## 11. 五维关系：循环与正交

五个维度不是彼此独立的，它们构成一个**四维循环** + 一个**正交维度**：

```
数据 ──CONTROLS──► 逻辑 ──LEADS_TO──► 时机 ──(跨函数NEXT)──► 顺序 ──(FLOWS推导)──► 数据
嵌套 ───────────────────────────── 正交 ─────────────────────────────► (可在任意节点相交)
```

| 步 | 语义 | 边 |
| --- | --- | --- |
| 数据 → 逻辑 | bool 表达式的值决定走哪个分支 | `(:Value)-[:CONTROLS]->(:Condition)` |
| 逻辑 → 时机 | 分支决定哪些调用发生 | `(:Condition)-[:LEADS_TO]->(:CalledMethod)` |
| 时机 → 顺序 | 调用把被调方法的执行插入调用者的顺序链 | `(:CalledMethod)-[:NEXT]->被调首事件 ... ->return槽-[:NEXT]->(:CalledReturn)-[:NEXT]->调用者后续` |
| 顺序 → 数据 | 写先于读才可达，末写→读构成数据流 | `FLOWS`（由执行顺序推导） |

**四维闭环查询**（从任意维度起步）：

```cypher
// 从数据出发：一个值一路影响 逻辑→时机→顺序→数据（跨函数）
MATCH p=(v:Value)-[:CONTROLS]->(c:Condition)-[:LEADS_TO]->(cm:CalledMethod)
      -[:NEXT]->(calleeFirst)-[:NEXT*1..5]->(calleeExit)-[:NEXT]->(cr:CalledReturn)-[:NEXT]->(callerNext:Value)
WHERE v.id=$dataId
RETURN p LIMIT 20
```

**嵌套维度正交性**：嵌套（`REF`/`INDEX`）讲的是**结构**（哪个实例访问哪个成员），不是**执行**（谁先谁后）。它不参与循环，但在循环的**任意节点**（条件/调用点/值）上都可以相交——即"相交搜索"的本质。

**循环的 may 语义**：顺序→数据在实现上是独立推导（FLOWS 来自数据流分析，非 NEXT 链计算），两者一致但不互斥——`order_true/false`（指定表达式真值）与对应分支的数据流天然对得上。

### 11.1 五维两两相交（交点位置决定单/双 MATCH）

每条维度是一条**有向线**（起点→终点）：数据 D=`FLOWS`（写→读）、逻辑 L=`CONTROLS→LEADS_TO`（守卫值→调用点）、时机 T=`CALLS`（调用点→被调方法）、顺序 O=`NEXT*`（最早→最晚）、嵌套 N=`REF`（实例→成员）。

**规律：一条线的终点/中途接上另一条的起点/中途 → 单 MATCH；两条线在交点同首或同尾 → 双 MATCH。**

| 对 | 交点 | 位置组合 | 单/双 | 查询 |
| --- | --- | --- | --- | --- |
| 数据∩逻辑 | 守卫值 v | D**尾** + L**首** | ✅单 | `(d)-[:FLOWS]->(v)-[:CONTROLS]->(c)-[:LEADS_TO]->(cm)` |
| 数据∩时机 | 实参槽 cp | D**尾** + T**首** | ✅单 | `(v)-[:FLOWS]->(cp)-[:ARG_OF]->(cm)-[:CALLS]->(m)` |
| 数据∩顺序 | 写a/读b | D 与 O **同首同尾**（两线平行共享两端） | ❌双 | `(a)-[:FLOWS]->(b), (a)-[:NEXT*1..8]->(b)` |
| 数据∩嵌套 | 值 v / 调用点 cm | v：D**尾**+N**首** ✅单<br>cm：D**尾**+N**尾** ❌双 | 分情形 | 单：`(d)-[:FLOWS]->(v)-[:REF]->(member)`<br>双：`(v1)-[:FLOWS]->(cp)-[:ARG_OF]->(cm), (v2)-[:REF]->(cm)` |
| 逻辑∩时机 | 调用点 cm | L**尾** + T**首** | ✅单 | `(c)-[:LEADS_TO]->(cm)-[:CALLS]->(m)` |
| 逻辑∩顺序 | 条件 c | L**中** + O**中** | ✅单 | `(v)-[:CONTROLS]->(c)-[:NEXT]->(next)` |
| 逻辑∩嵌套 | 调用点 cm | L**尾** + N**尾** | ❌双 | `(c)-[:LEADS_TO]->(cm), (v)-[:REF]->(cm)` |
| 时机∩顺序 | 调用点 cm | O**中** + T**首** | ✅单 | `(prev)-[:NEXT]->(cm)-[:CALLS]->(m)` |
| 时机∩嵌套 | 调用点 cm | N**尾** + T**首** | ✅单 | `(v)-[:REF]->(cm)-[:CALLS]->(m)` |
| 顺序∩嵌套 | 实例 v | O**中** + N**首** | ✅单 | `(prev)-[:NEXT]->(v)-[:REF]->(member)` |

需要**双 MATCH** 的三种（交点同尾/同首汇聚）：
- `数据∩顺序`：两线共享写/读两端（平行验证，天然双）
- `数据∩嵌套`@调用点：数据流到实参 且 实例引用同一调用点——**双尾汇聚**（README 相交例子的图库版）
- `逻辑∩嵌套`@调用点：逻辑到调用点 且 嵌套引用同一调用点——**双尾汇聚**

## 12. 已实现 / 待实现对照

| 搜索类型 | 状态 |
| --- | --- |
| 时机（调用）正反向 | ✅ `calls`/`callers` preset |
| 数据流动正反向 | ✅ `dataflow` preset |
| 逻辑控制 | ✅ `controls` preset |
| 类嵌套（REF/INDEX） | ✅ `nesting` preset + `INDEX` 边 |
| 相交搜索 | ✅ 双 MATCH 汇聚调用点 |
| 类范围（super/sub/inPackage） | ✅ `ancestors`/`descendants`/`inPackage` preset（需 param） |
| 多态 override 搜索 | ✅ `polymorphism` preset（OVERRIDES） |
| 执行顺序（第 5 方向） | ✅ `codeorder` preset（NEXT 边，旧项目亦未实现的补全） |
| 执行顺序 × 逻辑配合 | ✅ `order_true`/`order_false` preset：经 CONTROLS 找条件，走 then(NEXT)/else(ELSE) 链 |
| 排除（exclude*） | ⚠️ 可作为查询参数 |
| 正则 FA 引擎 | ❌ 不移植（cypher 原生支持路径模式） |
