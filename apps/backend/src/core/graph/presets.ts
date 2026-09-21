/**
 * 预置 cypher 模板（图模型见 doc/GRAPH_MODEL.md，搜索语义见 doc/SEARCH_GUIDE.md）。
 * $project 由后端注入；锚定用的输入统一走 $name（来自 param 参数）。
 *
 * <p><b>三条硬规则</b>（理由见 GRAPH_MODEL.md「NEXT 流搜索的三条规则」）：
 * <ol>
 *   <li><b>每个模板都必须锚定</b>（needsParam=true，用 $name 收窄到具体节点/方法/类/包）。
 *       不锚定 = 全库扫全部起点做变长展开，实测 `count(p)` 跑 6 分 52 秒未完；LIMIT 拦不住，
 *       因为每行都要先算出来。
 *   <li><b>不写 LIMIT</b>。目的是把结果画到图上；LIMIT 会在懒拉取里静默截断路径，
 *       少画的边不报错。有界性由锚定保证，不由 LIMIT 保证。
 *   <li><b>NEXT 流不 `RETURN p`，改用去重边</b>（{@code UNWIND relationships(p) AS r WITH DISTINCT r}）。
 *       含环的 NEXT 流里节点数不多、路径数却能爆炸：CallServerInterceptor.intercept 一个方法体
 *       379 个节点 → 19238 条路径。`RETURN p` 实测 10s / 1.3GB，去重边 2s / 309KB，
 *       而画到图上两者是同一套边。{@code count(p)} 更糟（要实体化全部路径）。
 * </ol>
 *
 * <p>本文件**不含 Nest 依赖、只有纯数据**，因为模板不只被 query_graph 工具用：
 * graph.service 的 expand_called_method（调用点→被调函数体）也要拼 codeorder，
 * 放在工具文件里会形成 service ↔ tool 的循环依赖。
 */

/**
 * codeorder / order_* 共用的收尾：从锚点（方法或条件）的 NEXT 链得到 body，补进运算符节点，
 * 再取出 body 内的 NEXT/FLOWS/REF/CONTROLS 边。
 *
 * <p><b>为什么要单独补运算符节点</b>：运算符只入 FLOWS、不入 NEXT（见 GraphExtractor
 * 的 emitOperatorIfAny），所以 `NEXT*` 走不到它们。但它们是操作数汇聚的值枢纽，
 * 不补进来 `responseBuilder` 那条 NEXT 链就会缺一段；CONTROLS 的守卫值有一半是运算符
 * （`==`/`&&`/`||`/`!`），不补进来这些守卫边全部看不到。
 *
 * <p><b>三条去重规则</b>（同一对节点只画最有信息量的一条）：
 * <ul>
 *   <li>NEXT 让位 FLOWS —— 数据依赖比时序相邻更有信息量。
 *   <li>NEXT 让位 REF —— 同理。实测同一对节点上 NEXT 与 REF 同向（47/47，反向 0），
 *       故用同一条方向判断即可，不会出现"该让的没让、不该让的让了"。
 *   <li>FLOWS 与 REF 可以共存 —— 它们讲的是两件事（值怎么合成 / 哪个实例访问哪个成员）。
 *   <li>CONTROLS 与 NEXT 也共存 —— 同样讲两件事：NEXT 说"守卫接着被求值"（时序），
 *       CONTROLS 说"这个值决定走哪个分支"（守卫关系）。实测 1,093 条 CONTROLS 与其
 *       守卫读→条件 的 NEXT 同向且并存，让位会丢掉"谁守卫了这个分支"这条关键语义。
 *       CONTROLS 也不与 FLOWS/REF 冲突（它指向 Condition，不是 Value）。
 *   <li>PARAM_TO_METHOD / METHOD_TO_RETURN 与 NEXT 也共存 —— 它们连"数据进出调用点"：
 *       PARAM_TO_METHOD（实参→调用点）与 NEXT 同向且平行（46 条里 38 条有平行 NEXT），
 *       让位会丢掉"这个值是作为实参进去的"。METHOD_TO_RETURN（调用点→返回值）与
 *       CalledMethod→CALLED_RETURN 的 NEXT 同向同对，前端"同对节点不画两条"会让它被
 *       NEXT 挡住 —— 但它是 调用点→返回值 这一跳的**语义命名**，与 PARAM_TO_METHOD
 *       拼成同向链，故保留（被挡掉不报错，只是不重复画线）。
 *   <li>两条接头边端点固定为 Value↔CalledMethod，不拉进 body 外的节点。
 * </ul>
 *
 * <p>REF / CONTROLS / PARAM_TO_METHOD / METHOD_TO_RETURN 只保留<b>两端都在 body 内</b>的边，不把 body 外的
 * 目标节点拉进来：本 preset 的语义是"这个函数体内发生了什么"，`exchange → connection`
 * 的 connection 声明在别的文件里，拉进来会让图超出方法体。实测 REF 这样保留 134/172 条。
 *
 * @param anchor body 的锚点变量名（codeorder 是 `m`，order_* 是 `c`）
 */
export function bodyTail(anchor: string): string {
  return (
    `OPTIONAL MATCH (o:Value {projectId:$project, kind:'OPERATOR'})-[:FLOWS*1..8]-(y) ` +
    "WHERE o.file CONTAINS $file AND y IN body " +
    `WITH ${anchor}, body, collect(DISTINCT o) AS ops ` +
    `WITH ${anchor}, body + [x IN ops WHERE x IS NOT NULL] AS full ` +
    "UNWIND full AS a MATCH (a)-[r:NEXT|FLOWS|REF|CONTROLS|PARAM_TO_METHOD|METHOD_TO_RETURN]->(b) " +
    "WHERE b IN full AND NOT (r:NEXT AND ((a)-[:FLOWS]->(b) OR (a)-[:REF]->(b))) RETURN a, r, b"
  );
}

export const PRESETS: Record<string, { description: string; needsParam: boolean; cypher: string }> = {
  nesting: {
    description: "数据的分形：某实例引用出发的 引用→调用点→被调方法（需 param=值名）",
    needsParam: true,
    cypher:
      "MATCH p=(v:Value {projectId:$project, name:$name})-[:REF]->(cm:CalledMethod)-[:CALLS]->(m:Method) RETURN p",
  },
  dataflow: {
    description: "数据流：某值出发的值→值链（需 param=值名）",
    needsParam: true,
    cypher:
      "MATCH p=(a:Value {projectId:$project, name:$name})-[:FLOWS*]->(b:Value {projectId:$project}) RETURN p",
  },
  types: {
    description: "类继承关系：某类的直接父类（需 param=类名）",
    needsParam: true,
    cypher:
      "MATCH p=(c:Class {projectId:$project, name:$name})-[:EXTENDS]->(sup:Class) RETURN p",
  },
  polymorphism: {
    description: "多态：某方法实际派发到哪些实现（需 param=方法名；同名多时用 file 收窄）",
    needsParam: true,
    cypher:
      "MATCH p=(declared:Method {projectId:$project, name:$name})<-[:OVERRIDES*]-(impl:Method) WHERE declared.file CONTAINS $file RETURN p",
  },
  ancestors: {
    description: "类范围 super(C)：某类的所有祖先类（需 param=类名）",
    needsParam: true,
    cypher:
      "MATCH p=(c:Class {projectId:$project, name:$name})-[:EXTENDS*]->(a:Class) RETURN p",
  },
  descendants: {
    description: "类范围 sub(C)：某类的所有子孙类（需 param=类名）",
    needsParam: true,
    cypher:
      "MATCH p=(c:Class {projectId:$project, name:$name})<-[:EXTENDS*]-(d:Class) RETURN p",
  },
  inPackage: {
    description: "类范围 inPackage(P)：某包下的所有类（需 param=包名前缀）",
    needsParam: true,
    cypher:
      "MATCH (c:Class {projectId:$project}) WHERE c.package STARTS WITH $name RETURN c",
  },
  intersection: {
    description:
      "相交：数据流(值→实参) ∩ 数据的分形(实例→调用) 汇聚于同一调用点（需 param=值名，锚定数据流起点）",
    needsParam: true,
    cypher:
      "MATCH (v1:Value {projectId:$project, name:$name})-[:FLOWS]->(cp:Value {projectId:$project,kind:'CALLED_PARAM'})-[:PARAM_TO_METHOD]->(cm:CalledMethod)-[:CALLS]->(m:Method) MATCH (v2:Value {projectId:$project})-[:REF]->(cm) RETURN v1, cp, cm, m, v2",
  },
  codeorder: {
    description:
      "某方法体内的四个维度 + 调用点接头：执行先后(NEXT) + 值流向(FLOWS) + 成员访问(REF)" +
      " + 分支守卫(CONTROLS) + 数据进出调用(PARAM_TO_METHOD/METHOD_TO_RETURN)" +
      "（需 param=方法名，从该方法沿 NEXT 走到函数尾）。" +
      "同一对节点上 NEXT 让位 FLOWS/REF（数据依赖、成员引用都比时序相邻更有信息量）；" +
      "FLOWS 与 REF 可共存（值怎么合成 / 哪个实例访问哪个成员，是两件事）；" +
      "CONTROLS 也与 NEXT 共存（守卫关系与时序是两件事，让位就丢了\"谁守卫了这个分支\"）；" +
      "PARAM_TO_METHOD/METHOD_TO_RETURN 同理共存（数据进出调用点是独立语义）。" +
      "REF/CONTROLS/PARAM_TO_METHOD/METHOD_TO_RETURN 只画两端都在方法体内的，不把体外目标拉进来。" +
      "同名方法多时会一起锚定（okhttp 有 18 个 intercept），用 file 收窄到某一个",
    needsParam: true,
    cypher:
      "MATCH (m:Method {projectId:$project, name:$name}) WHERE m.file CONTAINS $file " +
      "MATCH (m)-[:NEXT*]->(v {projectId:$project}) WITH m, collect(DISTINCT v) + m AS body " +
      bodyTail("m"),
  },
  order_true: {
    description:
      "某表达式为 true 时的四个维度 + 调用点接头：执行先后 + 值流向 + 成员访问 + 分支守卫" +
      " + 数据进出调用(PARAM_TO_METHOD/METHOD_TO_RETURN)" +
      "（需 param=表达式名，经 CONTROLS 找条件、走 then 的 NEXT 链）。" +
      "同一对节点上 NEXT 让位 FLOWS/REF；FLOWS 与 REF、CONTROLS/PARAM_TO_METHOD/METHOD_TO_RETURN 与 NEXT 各自可共存",
    needsParam: true,
    cypher:
      "MATCH (e:Value {projectId:$project, name:$name}) WHERE e.file CONTAINS $file " +
      "MATCH (e)-[:CONTROLS]->(c:Condition) MATCH (c)-[:NEXT*]->(v {projectId:$project}) " +
      "WITH c, collect(DISTINCT v) + c AS body " +
      bodyTail("c"),
  },
  order_false: {
    description:
      "某表达式为 false 时的四个维度 + 调用点接头：执行先后 + 值流向 + 成员访问 + 分支守卫" +
      " + 数据进出调用(PARAM_TO_METHOD/METHOD_TO_RETURN)" +
      "（需 param=表达式名，走条件 else 分支的链）。" +
      "同一对节点上 NEXT 让位 FLOWS/REF；FLOWS 与 REF、CONTROLS/PARAM_TO_METHOD/METHOD_TO_RETURN 与 NEXT 各自可共存",
    needsParam: true,
    cypher:
      "MATCH (e:Value {projectId:$project, name:$name}) WHERE e.file CONTAINS $file " +
      "MATCH (e)-[:CONTROLS]->(c:Condition) MATCH (c)-[:NEXT {branch:'false'}]->(v {projectId:$project}) " +
      "WITH c, collect(DISTINCT v) + c AS body " +
      bodyTail("c"),
  },
};

export const PRESET_NAMES = Object.keys(PRESETS) as [string, ...string[]];
