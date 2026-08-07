# scip-java 生成 index.scip 的构建兼容性问题与解决方案

> 场景：用 scip-java 给复杂 Gradle 项目（以 OkHttp 为例）生成 SCIP 索引时，除网络问题外遇到的
> 构建层兼容性问题及解决办法。网络问题见 [china-network-guide.md](china-network-guide.md)。

---

## 0. 问题全景

| 序号 | 问题 | 表现 | 根因 | 解决方案 |
| --- | --- | --- | --- | --- |
| 1 | `build-logic` 配置失败 | `Could not create task ':build-logic:compileKotlin'` / `freeCompilerArgs` provider 提前查询 | scip 插件应用到 kotlin-dsl 预编译脚本构建 | 自定义 init 脚本跳过 build-logic |
| 2 | `scipPrintDependencies` 崩溃 | `ConcurrentModificationException` | GraalVM native-image 插件并发修改配置 | 跳过 okcurl / native-image-tests |
| 3 | Kotlin 编译内部错误 | `NoSuchMethodError: CheckerContext.getContainingFile()` | scip-kotlinc 与项目 Kotlin 编译器版本 API 不匹配 | 从源码重新编译 scip-kotlinc 对齐 Kotlin 版本 |

---

## 1. build-logic（kotlin-dsl 预编译脚本）配置失败

### 问题现象

```
> Configure project :build-logic
...
FAILURE: Build failed with an exception.

* What went wrong:
A problem occurred configuring root project 'okhttp-parent'.
> Could not determine the dependencies of task ':build-logic:jar'.
   > Could not create task ':build-logic:compileKotlin'.
      > Failed to query the value of property 'freeCompilerArgs'.
         > Querying the mapped value of map(flatmap(provider(task 'generatePrecompiledScriptPluginAccessors', ...)))
           before task ':build-logic:generatePrecompiledScriptPluginAccessors' has completed is not supported
```

### 根因

1. scip-java 的 init 脚本会对**所有项目** `apply plugin: ScipGradlePlugin`，包括 `build-logic`
   这个 composite build（included build）。
2. `ScipGradlePlugin` 用 `tasks.configureEach(...)` 钩住 KotlinCompile 任务，并在回调里通过
   反射查询 `getFreeCompilerArgs()`。
3. `build-logic` 使用 kotlin-dsl **预编译脚本插件**（`PrecompiledScriptPlugins`），它的
   `freeCompilerArgs` 是一个依赖 `generatePrecompiledScriptPluginAccessors` 任务输出的
   **lazy provider**，只有在访问器任务执行完成后才能查询。
4. root 项目在**配置阶段**解析 `:build-logic:jar` 依赖时提前 realize 了该任务，触发
   provider 查询 → 报错。

### 无效的尝试（均已验证）

```sh
--no-configuration-cache          # ❌ 无效
-Dorg.gradle.isolated-projects=false   # ❌ 无效
切换 Gradle 版本（9.6.1 → 9.4.1）      # ❌ 无效，与版本无关
```

### 解决方案：自定义 init 脚本跳过 build-logic

核心思路：**绕开 scip-java 的 `index` 自动流程，手写 init 脚本，只对需要的项目应用
scip 插件，跳过 build-logic。**

```groovy
// scip-manual.gradle
initscript {
    dependencies { classpath(files("/scip-jars/gradle-plugin.jar")) }
}

import org.scip_code.scip_java.gradle.ScipGradlePlugin

def scipTarget = "/sources/build/scip-targetroot"
def javacPluginJar = "/scip-jars/scip-plugin.jar"
def dependenciesOut = scipTarget + "/dependencies.txt"
def scipKotlincJar = "/scip-jars/scip-kotlinc.jar"

allprojects {
    def skip = project.rootDir.name == "build-logic"   // 纯构建配置，无业务代码
    if (skip) {
        println "scip-manual: skipping project ${project.name}"
    } else {
        project.ext["scipTarget"] = scipTarget
        project.ext["javacPluginJar"] = javacPluginJar
        project.ext["dependenciesOut"] = dependenciesOut
        project.ext["scipKotlincJar"] = scipKotlincJar
        apply plugin: ScipGradlePlugin
    }
}
```

三个 jar 从镜像中提取：

```sh
docker run --rm -v "$PWD:/e" ghcr.io/scip-code/scip-java:latest sh -c '
  cd /app/scip-java/lib
  unzip -o -q -j scip-java-*.jar scip-plugin.jar gradle-plugin.jar scip-kotlinc.jar -d /e
'
```

> **Kotlin 项目必须用第 3 节重编的 scip-kotlinc.jar 覆盖这里提取的版本**（`gradle-plugin.jar`
> 和 `scip-plugin.jar` 是 Java 插件，不依赖 Kotlin 版本，直接用提取版即可）。若直接拿提取的
> scip-kotlinc.jar 跑 Kotlin 2.2.x+ 项目会崩。

手动执行（替代 `scip-java index`）：

```sh
gradle --no-daemon --init-script /scip-manual.gradle \
  -Pkotlin.compiler.execution.strategy=in-process \
  -Dscip.targetroot=/sources/build/scip-targetroot \
  --no-configuration-cache \
  clean scipPrintDependencies scipCompileAll
```

生成分片后，聚合为单个索引：

```sh
scip-java aggregate --targetroot=/sources/build/scip-targetroot --output=/sources/index.scip
```

### 为什么跳过 build-logic 无损

`build-logic` 是构建逻辑（约定插件、版本目录），**不包含任何应用代码**。索引它没有任何价值，
跳过可完全规避该错误。

---

## 2. scipPrintDependencies 崩溃（ConcurrentModificationException）

### 问题现象

```
> Task :okcurl:scipPrintDependencies FAILED
Skipping configuration 'nativeImageClasspath' due to resolution failure: ...
FAILURE: Build failed with an exception.
* What went wrong:
Execution failed for task ':okcurl:scipPrintDependencies'.
> java.util.ConcurrentModificationException (no error message)
```

### 根因

`WriteDependencies` 任务（scip-java 的 `scipPrintDependencies`）会迭代
`project.getConfigurations().forEach(...)` 并逐个 resolve。使用 **GraalVM native-image 插件**
的项目（okcurl、native-image-tests）会在执行期动态添加/修改配置，导致迭代过程中被并发修改，
抛出 `ConcurrentModificationException`。

### 解决方案

在 init 脚本里把这些 Graal 模块一并跳过（见上节脚本）：

```groovy
def skip = project.rootDir.name == "build-logic"
        || project.name == "okcurl"              // Graal native-image
        || project.name == "native-image-tests"  // Graal native-image
```

---

## 3. Kotlin 编译器版本不匹配（NoSuchMethodError）

### 问题现象

Kotlin 模块编译时崩溃：

```
e: org.jetbrains.kotlin.util.FileAnalysisException: ...
   java.lang.NoSuchMethodError: 'org.jetbrains.kotlin.fir.declarations.FirFile
     org.jetbrains.kotlin.fir.analysis.checkers.context.CheckerContext.getContainingFile()'
e: Compiler terminated with internal error
```

### 根因

`scip-kotlinc` 是一个 kotlinc 编译器插件，它内部的 FIR checker 代码直接依赖 Kotlin 编译器的
**内部 API**。Kotlin 版本（哪怕 patch 版本）之间 FIR API 都会变动，导致：

- 用 Kotlin X 编译的 scip-kotlinc，跑在 Kotlin Y 的编译器里 → `NoSuchMethodError`
- 例如：官方 release 的 scip-kotlinc 基于 Kotlin **2.2.0** 编译（fat-jar 内嵌
  `kotlin-compiler-embeddable-2.2.0`，实测 `CheckerContext` 只调用了 `getContainingFile`），
  OkHttp 用 Kotlin **2.2.21**（该 API 已改名为 `getContainingFileSymbol`）→ 崩溃

> 注意：KSP 版本 ≠ Kotlin 版本。OkHttp 的 KSP 是 `2.3.10`，但 Kotlin 实际是 `2.2.21`，
> 判断前一定要看 `gradle/libs.versions.toml` 里的 `kotlin = ...`。

### 解决方案：从源码重新编译 scip-kotlinc，对齐项目 Kotlin 版本

1. 用**接近项目 Kotlin 版本**的 scip-java 源码标签（`v0.13.1` 用的是 Kotlin 2.2.0，
   与 2.2.21 同代；main 分支用 2.4.10 反而更难适配）。
2. 修改 `gradle/libs.versions.toml` 把 `kotlin` 对齐到项目版本。
3. 给 `scip.kotlin-jvm` 约定插件加 `-Xcontext-parameters`（源码用了 context parameters）。
4. 修补 FIR API 差异。以 v0.13.1 适配 Kotlin 2.2.21 为例，共 3 处：

| 位置 | 2.4.x 写法 | 2.2.21 写法 |
| --- | --- | --- |
| `AnalyzerCheckers.kt` | `context.containingFile?.sourceFile` | `context.containingFileSymbol?.sourceFile` |
| `ScipTextDocumentBuilder.kt` | `firBasedSymbol.directOverriddenSymbolsSafe(context)` | 降级为 `emptyList()`（该方法在 2.2.21 变为 context 参数函数） |
| `ScipTextDocumentBuilder.kt` | `callableId.callableName` | `callableId?.callableName ?: name`（2.2.21 可为空） |

5. 构建并替换 jar：

```sh
gradle --no-daemon --no-configuration-cache :scip-kotlinc:shadowJar
# 产物: scip-kotlinc/build/libs/scip-kotlinc-*-all.jar
```

6. **把重编 jar 放到手动流程的 jar 目录**（覆盖官方提取的 2.2.0 版，见第 6 节）：

```sh
cp scip-kotlinc/build/libs/scip-kotlinc-*-all.jar /scip-jars/scip-kotlinc.jar
```

> 关键：`scip-java index` 自动流程会从 fat-jar 内嵌资源提取它自己的 scip-kotlinc.jar
> 到临时目录（`/tmp/scip-javaXXXX/`），**无法注入重编版**。因此凡是 Kotlin 项目（含 KMP/
> 多模块 Kotlin），**必须走第 6 节的手动流程**，并让 `scip-manual.gradle` 里的
> `scipKotlincJar` 指向 `/scip-jars/scip-kotlinc.jar`（重编版）。纯 Java 项目无此限制，
> 可直接用 `scip-java index`。

### 代价

- 方法 `override` 关系会缺失（`directOverriddenSymbolsSafe` 降级为空），但定义、引用、hover
  等核心导航不受影响。
- 重新编译的 scip-kotlinc **只对匹配的 Kotlin 版本**有效，换项目时需按版本重编。

---

## 4. 索引覆盖范围：跳过了什么

> 索引构建跑的是 `clean scipPrintDependencies scipCompileAll`，**只编译、不打包、不测试**。
> 下面列出所有"没进构建图"和"在构建图里但没执行"的部分，以及它们对索引的影响。

### 4.1 模块层面：根本没进构建图

OkHttp 的 `settings.gradle.kts` 有大量条件 `include`，容器环境未满足条件时这些模块
**完全不在构建里，索引天然不含它们**：

| 模块 | 触发条件 | 容器内实际 |
| --- | --- | --- |
| `android-test` / `android-test-app` | 设置了 `ANDROID_HOME` 或 `sdk.dir` | 未设置 → 未 include |
| `module-tests` | `okhttpModuleTests=true` | 默认 `false` → 未 include |
| `regression-test` | `androidBuild=true` | 默认 `false` → 未 include |
| `native-image-tests` | `graalBuild=true` | 默认 `false` → 未 include |

> 注：init 脚本里额外 skip 的 `okcurl`（Graal 插件）属于另一类——它在构建图里，但 scip
> 插件被跳过。`native-image-tests` 则根本未 include，skip 是双保险。

### 4.2 任务层面：在构建图里但未执行

`scipCompileAll` 对各模块只触发编译任务：
- KMP 模块：`compileKotlinJvm` / `compileTestKotlinJvm`
- Java 模块：`compileJava` / `compileTestJava`

因此测试**源码**会被编译并索引（索引里有大量 `src/test/...` 文件），但以下任务**不会执行**：

| 未执行任务 | 对索引的影响 |
| --- | --- |
| `jar` / `assemble` / 打包 | 无影响（索引不依赖产物） |
| `compileJavaModuleInfo`（okhttp 核心） | **会执行**（随 `compileKotlinJvm` 链进入任务图），但 module-info 不产生有效索引数据，见 4.3 |
| `test` 运行 | 无影响（测试代码已被编译索引） |
| `check` / `build` 完整生命周期 | 无影响 |
| dokka / OSGi / 其他自定义任务 | 无影响 |

### 4.3 `compileJavaModuleInfo` 硬编码 JDK 11（实测修正）

okhttp 核心模块 `okhttp/build.gradle.kts` 第 227 行：

```kotlin
val compileJavaModuleInfo by tasks.registering(JavaCompile::class) {
  ...
  // Use a Java 11 compiler for the module info.
  javaCompiler.set(project.javaToolchains.compilerFor { languageVersion.set(JavaLanguageVersion.of(11)) })
```

**实测：`scipCompileAll` 会把它拉进任务图，绕不开。** `dry-run` 显示 okhttp 模块的任务链：
`compileKotlinJvm → compileJavaModuleInfo → compileJvmMainJava → jvmMainClasses → jvmJar`。
它输出到 `compileKotlinJvm` 的 `destinationDirectory.dir("../java9")` 且被 `jvmJar`
的 `from(...)` 引用，所以跑 `scipCompileAll` 时必然执行。没有 JDK 11 时报：
`matching: {languageVersion=11, ...}. Toolchain auto-provisioning is not enabled.`

> 之前一次 4m45s 的运行没报此错，是因为它在 **okhttp 核心模块**编译前就崩于
> Kotlin 版本问题（见第 3 节），所以该任务从没执行到；修好 Kotlin 后才会暴露。

- 注意：**子模块**的 `module-info.java`（`src/main/java9/`）走的是另一套 mrjar 方案
  （`compileJava9Java`，用项目 toolchain=21），只有 **okhttp 核心模块**用 JDK 11。

**对索引完整性的影响：可忽略。** 一个 `module-info.java` 在索引里只贡献 2 个 occurrence：
`@SuppressWarnings` 注解引用 + 包根引用，都是 `reference`、无 definition/symbol，对代码导航零价值。
module-info 的源码也不在 `scipCompileAll` 的索引范围内。

**解法：装 JDK 11 并让 Gradle 发现它**（已验证，aarch64 容器）：

```sh
# 1. 国内镜像下载 Temurin 11（aarch64；x64 路径同理改 jdk/x64）
curl -sL -o /tmp/jdk11.tar.gz \
  "https://mirrors.tuna.tsinghua.edu.cn/Adoptium/11/jdk/aarch64/linux/OpenJDK11U-jdk_aarch64_linux_hotspot_11.0.32_9.tar.gz"
mkdir -p /opt/jdk11 && tar -xzf /tmp/jdk11.tar.gz --strip-components=1 -C /opt/jdk11

# 2. 在项目 gradle.properties 追加（与已有的 jdk21 并存）
org.gradle.java.installations.paths=/opt/jdk21,/opt/jdk11
```

> Tuna 的 Adoptium 目录路径已从 `openjdk11/` 变为 `11/jdk/<arch>/linux/`，文件版本随滚动更新
> （本例为 `11.0.32_9`），用 `curl -sL <目录>/?C=N;O=D` 列出最新文件名。
> 不要用 `cs java --jvm 11`（容器无 coursier，且那是本机方案）。
> 备选：把 `JavaLanguageVersion.of(11)` 改为 `of(21)`（改项目源码），同样可用——但
> `scipCompileAll` 会真实执行该任务，缺 JDK 11 时改源码是更轻的方案。

### 4.4 任务内的部分跳过（warning，非致命）

`scipPrintDependencies`（`WriteDependencies`）对解析失败的 configuration 只打 warning 并跳过，
**不影响索引生成**：

- okhttp 模块的 `androidHostTest*` / `androidDeviceTest*` 等配置（无 Android SDK）
- okcurl 的 `nativeImageClasspath`
- `okhttp-bom` 没有 `main` source set → cross-repo 元数据缺失（`SourceSet with name 'main' not found`）

---

## 5. 排查顺序建议

出现构建失败时按以下顺序排查：

1. **看是不是网络**：错误里出现 `Could not get resource`、`Could not connect`、TLS → 走
   [china-network-guide.md](china-network-guide.md) 的镜像方案。
2. **看是不是 build-logic**：错误定位到 `:build-logic:*` 且提到 `freeCompilerArgs` /
   `generatePrecompiledScriptPluginAccessors` → 用本节方案跳过 build-logic。
3. **看是不是 Kotlin 版本**：`NoSuchMethodError` / `Compiler terminated with internal error`
   且堆栈里是 `org.jetbrains.kotlin.fir.*` → 重编 scip-kotlinc 对齐版本。
4. **看是不是 Graal 模块**：`ConcurrentModificationException` 在 `scipPrintDependencies` →
   跳过该模块。
5. **看是不是 toolchain 缺失**：`Cannot find a Java installation ... matching: {languageVersion=N}` →
   按项目所需 JDK 版本装到 `/opt`，并在 `gradle.properties` 的
   `org.gradle.java.installations.paths` 里追加路径（见 4.3）。
6. **看是不是 scip-java 自身 toolchain**：构建 scip-kotlinc 时
   `Toolchain installation ... does not provide the required capabilities: [JAVA_COMPILER]`
   → 给 `gradle.properties` 加 `org.gradle.java.home=/opt/jdk21`（Gradle 本身跑在 JDK21，
   使 build-logic 的 kotlin-dsl 编译能用上；`org.gradle.java.installations.paths` 在该场景不生效）。

---

## 6. 手动流程总览（替代 `scip-java index`）

```sh
# 1. 提取三个 jar
# 2. 写 scip-manual.gradle（跳过 build-logic / Graal 模块）
# 3. 编译并生成分片
gradle --no-daemon --init-script /scip-manual.gradle \
  -Pkotlin.compiler.execution.strategy=in-process \
  -Dscip.targetroot=<targetroot> --no-configuration-cache \
  clean scipPrintDependencies scipCompileAll

# 4. 聚合
#    聚合不涉及 Kotlin 编译器，镜像里的官方 scip-java（fat-jar）自带 aggregate 子命令即可。
#    若容器里没有 CLI，可从源码构建：scip-java 模块是 application（主类 ScipJava），
#    gradle --no-daemon --no-configuration-cache :scip-java:installDist
scip-java aggregate --targetroot=<targetroot> --output=index.scip

# 5.（可选）修正 projectRoot 元数据（若在副本/容器中构建，路径与实际仓库不一致）
```

> 该手动流程绕开了 `scip-java index` 的自动检测，但核心机制相同：通过 init 脚本应用
> `ScipGradlePlugin` 挂载 javac/kotlinc 编译器插件，产出逐文件 SCIP 分片后再聚合。

### 适用边界

| 项目类型 | 用什么流程 | 原因 |
| --- | --- | --- |
| 纯 Java | `scip-java index`（自动） | 不涉及 scip-kotlinc，官方 jar 即可 |
| Kotlin（含 KMP/多 Kotlin 模块） | **手动流程** + 按版本重编 scip-kotlinc | 官方 scip-kotlinc 基于 Kotlin 2.2.0 编译，对 2.2.x+ 项目必崩（第 3 节） |

### 验证（以 OkHttp 为例，实测通过）

- 全量 `clean scipPrintDependencies scipCompileAll` → `BUILD SUCCESSFUL in ~1m12s`
  （Kotlin 2.2.21 对齐后，见第 3 节）。
- 聚合产出 `index.scip`（OkHttp ≈ 28MB / 553 个 SCIP 分片），含 `src/jvmMain` 与
  `jvmTest` 测试源码文件。
