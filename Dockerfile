# ---------- Stage 1: backend deps + build ----------
FROM node:20-slim AS backend-build
# npm 走 npmmirror + apt 走清华源（国内网络无需 VPN）
ENV npm_config_registry=https://registry.npmmirror.com \
    npm_config_replace_registry_host=always
RUN sed -i 's|https\?://[^/]*deb\.debian\.org/debian-security|http://mirrors.tuna.tsinghua.edu.cn/debian-security|g; s|https\?://[^/]*deb\.debian\.org/debian|http://mirrors.tuna.tsinghua.edu.cn/debian|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
    sed -i 's|https\?://[^/]*deb.debian.org|http://mirrors.tuna.tsinghua.edu.cn/debian|g' /etc/apt/sources.list 2>/dev/null
WORKDIR /build/backend
COPY apps/backend/package.json apps/backend/package-lock.json ./
RUN npm ci
COPY apps/backend ./
RUN npm run build
# prune to production dependencies only (smaller final image)
RUN npm ci --omit=dev

# ---------- Stage 2: gui (debug console) build ----------
FROM node:20-slim AS gui-build
ENV npm_config_registry=https://registry.npmmirror.com \
    npm_config_replace_registry_host=always
WORKDIR /build/gui
COPY apps/gui/package.json apps/gui/package-lock.json ./
RUN npm ci
COPY apps/gui ./
RUN npm run build

# ---------- Stage 2c: graph-app (Three.js 3D 图渲染页) build ----------
FROM node:20-slim AS graph-app-build
ENV npm_config_registry=https://registry.npmmirror.com \
    npm_config_replace_registry_host=always
WORKDIR /build/graph-app
COPY apps/graph-app/package.json apps/graph-app/package-lock.json ./
RUN npm ci
COPY apps/graph-app ./
RUN npm run build

# ---------- Stage 3: native C++ compile ----------
FROM node:20-slim AS native-build
RUN sed -i 's|https\?://[^/]*deb\.debian\.org/debian-security|http://mirrors.tuna.tsinghua.edu.cn/debian-security|g; s|https\?://[^/]*deb\.debian\.org/debian|http://mirrors.tuna.tsinghua.edu.cn/debian|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
    sed -i 's|https\?://[^/]*deb.debian.org|http://mirrors.tuna.tsinghua.edu.cn/debian|g' /etc/apt/sources.list 2>/dev/null
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build/native
COPY native/cpp ./cpp
RUN g++ -O2 -std=c++17 -o /build/worker cpp/worker.cpp

# ---------- Stage 4: production image ----------
FROM node:20-slim

LABEL org.opencontainers.image.description="shishan MCP server — Docker image with web console + Streamable HTTP MCP"
LABEL org.opencontainers.image.licenses=MIT

# nginx serves the web page, dumb-init is PID 1, python3 powers the venv,
# libstdc++ is the runtime lib for the compiled C++ worker.
RUN sed -i 's|https\?://[^/]*deb\.debian\.org/debian-security|http://mirrors.tuna.tsinghua.edu.cn/debian-security|g; s|https\?://[^/]*deb\.debian\.org/debian|http://mirrors.tuna.tsinghua.edu.cn/debian|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
    sed -i 's|https\?://[^/]*deb.debian.org|http://mirrors.tuna.tsinghua.edu.cn/debian|g' /etc/apt/sources.list 2>/dev/null
RUN apt-get update && apt-get install -y --no-install-recommends \
        nginx dumb-init python3 python3-venv python3-pip libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 1001 -r app \
    && useradd -r -g app -u 1001 -d /app -s /bin/false app \
    && mkdir -p /app

# Isolated Python venv for the MCP tools' python workers.
RUN python3 -m venv /opt/venv

WORKDIR /app

# Backend (dist + prod node_modules)
COPY --from=backend-build /build/backend/dist ./backend/dist
COPY --from=backend-build /build/backend/node_modules ./backend/node_modules
COPY --from=backend-build /build/backend/package.json ./backend/package.json

# Python scripts + pip deps（pip 走清华源）
COPY native/python ./native/python
RUN PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
    /opt/venv/bin/pip install --no-cache-dir -r native/python/requirements.txt

# Compiled C++ worker
COPY --from=native-build /build/worker /opt/bin/worker

# Frontend static files (served by nginx)
COPY --from=gui-build /build/gui/dist /usr/share/nginx/html
COPY --from=graph-app-build /build/graph-app/dist /usr/share/nginx/html-graph

# nginx + startup（Debian 的 nginx 配置目录是 /etc/nginx/conf.d/）。
# 必须删掉 Debian 包自带的 sites-enabled/default：它 `listen 80 default_server`，
# 会抢占 80 端口（而我们 conf.d/default.conf 只是普通 listen 80），
# 导致 18080 显示 "Welcome to nginx!" 而非 MCP 控制台。
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
RUN rm -f /etc/nginx/sites-enabled/default
COPY docker/start.sh /app/start.sh
RUN chmod +x /app/start.sh

RUN mkdir -p /run/nginx /var/lib/nginx /var/log/nginx && \
    chown -R app:app /app && \
    chown -R app:app /usr/share/nginx/html && \
    chown -R app:app /usr/share/nginx/html-graph && \
    chown -R app:app /var/lib/nginx && \
    chown -R app:app /var/log/nginx && \
    chown -R app:app /run/nginx

USER app

EXPOSE 80 82 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["sh", "/app/start.sh"]
