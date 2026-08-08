# scip-java 在中国大陆生成 index.scip 的网络问题与解决方案

> 场景：在中国大陆环境下，拉取 `ghcr.io/scip-code/scip-java` 镜像，并用它给 Gradle/Maven
> 项目（以 OkHttp 为例）生成 SCIP 索引时遇到的所有网络问题及解决办法。
>
> 结论：整个生成 `index.scip` 的流程**不需要 VPN**，全部通过国内镜像完成。

---

## 0. 问题全景

| 序号 | 资源 | 问题表现 | 解决方案 |
| --- | --- | --- | --- |
| 1 | `ghcr.io` Docker 镜像 | `docker pull` 直接超时 | 南大 ghcr 代理 + 重新打 tag |
| 2 | `dl.google.com`（Gradle `google()` 仓库） | 直连超时 | Gradle init 脚本重定向到阿里云 google 镜像 |
| 3 | `plugins.gradle.org`（插件门户） | TLS 握手被重置（GFW 干扰） | 重定向到阿里云 gradle-plugin 镜像 |
| 4 | `repo.maven.apache.org`（Maven Central） | 偶发 TLS 握手失败、速度慢 | 重定向到腾讯 maven-public 镜像 |
| 5 | 阿里云 central 的 `com.google.devtools.ksp` 组 | 固定返回 HTTP 502 | central 镜像改用腾讯（腾讯有完整 KSP） |
| 6 | `services.gradle.org` Gradle 发行版 | 下载慢 | 从腾讯镜像预下载并预热缓存，或用镜像自带 Gradle |

---

## 1. 拉取 Docker 镜像（ghcr.io）

### 问题
`docker pull ghcr.io/scip-code/scip-java:latest` 卡住直到超时。
`ghcr.io`（GitHub Container Registry）在中国大陆基本不可直连。

### 关键认知
- `~/.docker/daemon.json` 里的 `registry-mirrors` **只对 Docker Hub（`docker.io`）生效**，
  对 `ghcr.io` 无效。
- 需要的是 **ghcr 专用代理**（形如 `ghcr.<镜像站>.com`），这是公网镜像站，无需 VPN。

### 方案

**① 配置 Docker Hub 镜像源（可选，仅影响 docker.io 的拉取）**

`~/.docker/daemon.json`：

```json
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://docker.1panel.live",
    "https://hub.rat.dev",
    "https://dockerproxy.net"
  ]
}
```

改完重启 Docker Desktop（`pkill -f Docker.app && open -a Docker`）。

**② 用 ghcr 代理拉取并改回原名**

实测可用的 ghcr 代理（可用 `curl -I https://<host>/v2/` 测连通性）：

| 代理 | 备注 |
| --- | --- |
| `ghcr.nju.edu.cn` | 南京大学，最快 |
| `ghcr.dockerproxy.net` | 备用 |

```sh
docker pull ghcr.nju.edu.cn/scip-code/scip-java:latest
docker tag ghcr.nju.edu.cn/scip-code/scip-java:latest ghcr.io/scip-code/scip-java:latest
```

以后遇到任意 `ghcr.io/xxx` 镜像，套路都是：前缀换成 `ghcr.nju.edu.cn/` 拉取 → 重新 tag 回原名。

---

## 2. Gradle 依赖仓库被墙 → init 脚本重定向

### 问题
生成索引时 Gradle 需要访问三个仓库，国内都不可靠：

| Gradle 仓库声明 | 实际地址 | 症状 |
| --- | --- | --- |
| `google()` | `https://dl.google.com/dl/android/maven2/` | 直连超时 |
| `gradlePluginPortal()` | `https://plugins.gradle.org/m2/` | TLS 握手被重置 |
| `mavenCentral()` | `https://repo.maven.apache.org/maven2/` | 偶发握手失败、慢 |

### 方案：Gradle init 脚本 + 国内镜像

把下面的脚本放到 `~/.gradle/init.d/scip-repos.gradle`，它会对**所有** Gradle 构建自动生效
（包括 scip-java 启动的构建），**无需改动被索引的项目**。

```groovy
// ~/.gradle/init.d/scip-repos.gradle
def trim = { String u -> u.replaceAll(/\/+$/, '') }

def mirrors = [
  "https://dl.google.com/dl/android/maven2": "https://maven.aliyun.com/repository/google",
  "https://repo.maven.apache.org/maven2":    "https://mirrors.cloud.tencent.com/nexus/repository/maven-public",
  "https://repo1.maven.org/maven2":          "https://mirrors.cloud.tencent.com/nexus/repository/maven-public",
  "https://plugins.gradle.org/m2":           "https://maven.aliyun.com/repository/gradle-plugin"
]

def redirect = { repo ->
  if (repo instanceof MavenArtifactRepository) {
    def u = trim(repo.url.toString())
    mirrors.each { from, to ->
      if (u.startsWith(from)) {
        repo.setUrl(to)
        println "scip-mirror: ${u} -> ${to}"
      }
    }
  }
}

settingsEvaluated { settings ->
  settings.pluginManagement.repositories.all(redirect)
  settings.dependencyResolutionManagement.repositories.all(redirect)
}

allprojects {
  buildscript.repositories.all(redirect)
  repositories.all(redirect)
}
```

### 关键细节（踩过的坑）

1. **尾斜杠问题**：Gradle 实际的仓库 URL 是 `https://plugins.gradle.org/m2`
   （**没有**尾斜杠），如果映射表写成带 `/` 的 `https://plugins.gradle.org/m2/` 再
   `startsWith`，永远匹配不上。必须先去掉尾部斜杠再比较。

2. **四处都要覆盖**：仓库声明可能在 4 个地方，只改一处会漏：
   - `settings.pluginManagement.repositories`（插件解析）
   - `settings.dependencyResolutionManagement.repositories`（settings 级依赖仓库）
   - 项目 `buildscript.repositories`（buildscript 依赖）
   - 项目级 `repositories {}`（`build.gradle.kts` 里的声明，OkHttp 的 build-logic 就靠它）

3. **为什么 central 用腾讯而不是阿里云**：阿里云 central 镜像对部分分组返回 502，
   实测 `com.google.devtools.ksp`（KSP 插件）在阿里云 central 持续 502，而腾讯
   `maven-public` 完整可用。腾讯镜像同样能覆盖 spotless、durian 等常见依赖。

4. **init.d 脚本对 included build（如 `build-logic`）也生效**：`--init-script` 和
   `init.d` 里的脚本会传播到 composite build，所以一个脚本能覆盖全部子项目。
   脚本执行顺序是 CLI `--init-script` 先、`init.d` 后。

5. **镜像可用性快速自测**：

```sh
# 拉取某个具体 POM 判断镜像是否有货
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://maven.aliyun.com/repository/google/com/android/tools/build/gradle/9.1.1/gradle-9.1.1.pom"
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://mirrors.cloud.tencent.com/nexus/repository/maven-public/com/google/devtools/ksp/com.google.devtools.ksp.gradle.plugin/2.3.10/com.google.devtools.ksp.gradle.plugin-2.3.10.pom"
```

---

## 3. Gradle 发行版下载加速

wrapper 默认从 `services.gradle.org` 下载 `gradle-9.6.1-bin.zip`（约 140MB），慢。

**方案一：从腾讯镜像预下载并预热到 Gradle 缓存**

```sh
curl -o gradle-9.6.1-bin.zip \
  "https://mirrors.cloud.tencent.com/gradle/gradle-9.6.1-bin.zip"
```

**方案二（更省事）：直接用 scip 网关镜像自带的 Gradle**

scip-java 的 `index` 命令优先用项目的 `gradlew`，若把 `gradlew`/`gradlew.bat` 移除，
它会回退到 `PATH` 里的 `gradle`（容器内是 `/usr/local/bin/gradle`，link 到
`/opt/gradle/gradle-<version>`，版本跟随 `docker/scip/Dockerfile` 的 `GRADLE_VERSION`，
当前默认 `9.6.1`，与 OkHttp 等主流项目的 wrapper 一致，可 `--build-arg` 覆盖），
从而跳过 wrapper 发行版下载。缺点是要在项目副本上操作，且 Gradle 版本与 wrapper 锁定的不同。

---

## 4. 最终可复用清单

### 必备：镜像加速

```sh
# ghcr 镜像（scip-java）
docker pull ghcr.nju.edu.cn/scip-code/scip-java:latest
docker tag ghcr.nju.edu.cn/scip-code/scip-java:latest ghcr.io/scip-code/scip-java:latest

# Docker Hub 镜像源（可选）
# ~/.docker/daemon.json -> registry-mirrors
```

### 必备：Gradle 仓库镜像（`~/.gradle/init.d/scip-repos.gradle`）

见第 2 节脚本，四组映射：

- `dl.google.com` → `maven.aliyun.com/repository/google`
- `repo.maven.apache.org` / `repo1.maven.org` → `mirrors.cloud.tencent.com/nexus/repository/maven-public`
- `plugins.gradle.org` → `maven.aliyun.com/repository/gradle-plugin`

---

## 5. 验证命令

```sh
# Docker 镜像能跑
docker run --rm ghcr.io/scip-code/scip-java:latest scip-java --help

# 镜像重定向生效（看构建日志里的 scip-mirror 行）

# 镜像连通性
curl -s -o /dev/null -w "%{http_code}\n" -I https://ghcr.nju.edu.cn/v2/
curl -s -o /dev/null -w "%{http_code}\n" --max-time 8 https://maven.aliyun.com/repository/google/
```
