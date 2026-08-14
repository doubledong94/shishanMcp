# ---------- scip 网关镜像 ----------
# 提供生成 index.scip + 转换 JSON 的 HTTP 服务（docker/scip/server.js）。
#
# 依赖：
#   - scip CLI（Go 二进制，sourcegraph/scip release）用于 scip print（protobuf->JSON）
#   - scip-typescript / scip-python（npm 全局包）用于 TS/JS/Python 索引
#   - scip-java（JVM fat-jar，scip-code/scip-java release）用于 Java/Scala/Kotlin 索引
#   - scip-clang（原生二进制，sourcegraph/scip-clang release）用于 C/C++ 索引
#   - scip-go 走 go install；scip-ruby / scip-dotnet 等可按需补充
#
# 注意国内网络：构建阶段联网走构建代理（与主 Dockerfile 相同的 --build-arg 注入策略）。

FROM node:20-slim AS runtime

ARG SCIP_VERSION=v0.9.0
ARG SCIP_JAVA_VERSION=v0.13.1
ARG SCIP_CLANG_VERSION=v0.4.0

# 构建代理（compose 把 shell 导出的 HTTP_PROXY 等作为 build args 注入，见 README「国内网络」节）
ARG http_proxy
ARG https_proxy
ARG all_proxy

# 基础工具：curl/tar/gzip 下载 release；golang 供 go install；python3 供 scip-python 的 venv 场景；
# openjdk-17-jre-headless 供 scip-java（JVM fat-jar）运行；unzip 解压 Gradle 发行版。
# 注意 base 镜像与主 Dockerfile 一样用 node:20-slim（glibc），scip-clang 的 x86_64-linux 资产才能跑。
# 全部走国内源：apt 换清华源，npm 用 npmmirror，Gradle 用腾讯镜像——构建无需 VPN。
# Debian 12 的 deb822 里 security 也是 deb.debian.org/debian-security，须精确区分两条路径
RUN sed -i \
        's|https\?://[^/]*deb\.debian\.org/debian-security|http://mirrors.tuna.tsinghua.edu.cn/debian-security|g; s|https\?://[^/]*deb\.debian\.org/debian|http://mirrors.tuna.tsinghua.edu.cn/debian|g' \
        /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
    sed -i \
        's|https\?://[^/]*deb\.debian\.org/debian-security|http://mirrors.tuna.tsinghua.edu.cn/debian-security|g; s|https\?://[^/]*deb\.debian\.org/debian|http://mirrors.tuna.tsinghua.edu.cn/debian|g' \
        /etc/apt/sources.list 2>/dev/null; \
    apt-get update && apt-get install -y --no-install-recommends \
        curl tar gzip unzip coreutils ca-certificates golang-go python3 python3-pip openjdk-17-jre-headless \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g --registry=https://registry.npmmirror.com @sourcegraph/scip-typescript @sourcegraph/scip-python

# 预装 Gradle 9.6.1（腾讯镜像，无需 VPN）。scip-java 探测到项目没有 gradlew 时会用 PATH 里的
# gradle，从而跳过 wrapper 发行版下载（services.gradle.org 在国内不可靠）。
# 版本可覆盖：ARG GRADLE_VERSION，默认 9.6.1（与 okhttp 等主流项目的 wrapper 一致）。
ARG GRADLE_VERSION=9.6.1
RUN curl -fsSL "https://mirrors.cloud.tencent.com/gradle/gradle-${GRADLE_VERSION}-bin.zip" -o /tmp/gradle.zip \
    && mkdir -p /opt/gradle \
    && unzip -q /tmp/gradle.zip -d /opt/gradle \
    && ln -s /opt/gradle/gradle-${GRADLE_VERSION}/bin/gradle /usr/local/bin/gradle \
    && rm /tmp/gradle.zip \
    && (gradle --version 2>&1 | grep -E "Gradle [0-9]" || true)

# 预装 JDK 21（Eclipse Temurin，清华 Adoptium 镜像，无需 VPN）：
# okhttp 等项目的 Gradle toolchain 需要 JDK 21，且 Gradle 自动下载 toolchain 未配下载源
# 会报 "No defined toolchain download url for LINUX"。JDK17 仅供 scip-java launcher 自身运行。
ARG JDK21_VERSION=21.0.12_8
RUN JDK21_ARCH="$(uname -m | sed 's/x86_64/x64/; s/aarch64/aarch64/')" && \
    curl -fsSL "https://mirrors.tuna.tsinghua.edu.cn/Adoptium/21/jdk/${JDK21_ARCH}/linux/OpenJDK21U-jdk_${JDK21_ARCH}_linux_hotspot_${JDK21_VERSION}.tar.gz" -o /tmp/jdk21.tar.gz \
    && mkdir -p /opt/jdk21 \
    && tar -xzf /tmp/jdk21.tar.gz -C /opt/jdk21 --strip-components=1 \
    && rm /tmp/jdk21.tar.gz \
    && /opt/jdk21/bin/java -version 2>&1 | head -1

# 预装 JDK 11（Temurin，清华 Adoptium 镜像）：okhttp 核心模块的 compileJavaModuleInfo
# 硬编码 JDK 11 toolchain（okhttp/build.gradle.kts:227），缺它会让 scipCompileAll 失败，
# 见 doc/gradle-compat-guide.md 4.3。版本随镜像滚动更新（Tuna 目录 11/jdk/<arch>/linux/）。
ARG JDK11_VERSION=11.0.32_9
RUN JDK11_ARCH="$(uname -m | sed 's/x86_64/x64/; s/aarch64/aarch64/')" && \
    curl -fsSL "https://mirrors.tuna.tsinghua.edu.cn/Adoptium/11/jdk/${JDK11_ARCH}/linux/OpenJDK11U-jdk_${JDK11_ARCH}_linux_hotspot_${JDK11_VERSION}.tar.gz" -o /tmp/jdk11.tar.gz \
    && mkdir -p /opt/jdk11 \
    && tar -xzf /tmp/jdk11.tar.gz -C /opt/jdk11 --strip-components=1 \
    && rm /tmp/jdk11.tar.gz \
    && /opt/jdk11/bin/java -version 2>&1 | head -1

# GitHub release 下载加速前缀（国内无需 VPN）。实测 ghfast.top 对 scip release 可用。
ARG GH_PROXY=https://ghfast.top

# 下载 scip CLI（含 scip print）
RUN SCIP_ARCH="$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')" && \
    curl -fsSL "${GH_PROXY}/https://github.com/sourcegraph/scip/releases/download/${SCIP_VERSION}/scip-linux-$SCIP_ARCH.tar.gz" -o /tmp/scip.tar.gz \
    && tar -xzf /tmp/scip.tar.gz -C /usr/local/bin \
    && rm /tmp/scip.tar.gz \
    && (scip version || true)

# scip-java：跨平台 JVM fat-jar（无需按架构区分），用法 scip-java index（Gradle/Maven 项目）
RUN curl -fsSL "${GH_PROXY}/https://github.com/scip-code/scip-java/releases/download/${SCIP_JAVA_VERSION}/scip-java-${SCIP_JAVA_VERSION}" -o /usr/local/bin/scip-java \
    && chmod +x /usr/local/bin/scip-java \
    && (scip-java --help >/dev/null 2>&1 || true)

# scip-clang：原生二进制。官方只有 x86_64-linux / arm64-darwin 资产，没有 arm64-linux，
# 因此 arm64（如 Apple Silicon 的 linux/arm64 容器）跳过安装，server.js 会自动报"未安装"。
# 用法 scip-clang --compdb-path=<项目>/compile_commands.json（C/C++ 项目需先生成编译数据库）。
RUN SCIP_ARCH="$(uname -m)" && \
    if [ "$SCIP_ARCH" = "x86_64" ] || [ "$SCIP_ARCH" = "amd64" ]; then \
      curl -fsSL "${GH_PROXY}/https://github.com/sourcegraph/scip-clang/releases/download/${SCIP_CLANG_VERSION}/scip-clang-x86_64-linux" -o /usr/local/bin/scip-clang \
      && chmod +x /usr/local/bin/scip-clang \
      && (scip-clang --help >/dev/null 2>&1 || true); \
    else \
      echo "scip-clang 没有 $SCIP_ARCH-linux 资产，跳过安装（C/C++ 索引不可用）"; \
    fi

WORKDIR /app
COPY server.js /app/server.js

# Gradle 仓库重定向到国内镜像的 init 脚本（对 scip-java 发起的每个构建生效，无需 VPN）
COPY scip-repos.gradle /home/scip-gradle-init/scip-repos.gradle

RUN groupadd -r scip && useradd -r -g scip -d /home/scip -s /bin/false scip \
    && mkdir -p /home/scip /home/scip/.gradle/init.d \
    && cp /home/scip-gradle-init/scip-repos.gradle /home/scip/.gradle/init.d/scip-repos.gradle \
    && rm -rf /home/scip-gradle-init \
    && chown -R scip:scip /home/scip

USER scip

# useradd 的 -d 决定 JVM 的 user.home（java 不读 $HOME 环境变量）。
# scip-java 的 coursier launcher 在 $user.home/.cache 建缓存，
# 默认 -d /app（root 拥有）会导致 AccessDeniedException。故 home 指到可写的 /home/scip。
ENV HOME=/home/scip

EXPOSE 8000

ENV SCIP_DATA_ROOT=/data/scip \
    PORT=8000

CMD ["node", "/app/server.js"]
