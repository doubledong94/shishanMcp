# ---------- Stage 1: backend deps + build ----------
FROM node:20-alpine AS backend-build
WORKDIR /build/backend
COPY apps/backend/package.json apps/backend/package-lock.json ./
RUN npm ci
COPY apps/backend ./
RUN npm run build
# prune to production dependencies only (smaller final image)
RUN npm ci --omit=dev

# ---------- Stage 2: gui (debug console) build ----------
FROM node:20-alpine AS gui-build
WORKDIR /build/gui
COPY apps/gui/package.json apps/gui/package-lock.json ./
RUN npm ci
COPY apps/gui ./
RUN npm run build

# ---------- Stage 2b: gui-app (real MCP functionality page) build ----------
FROM node:20-alpine AS gui-app-build
WORKDIR /build/gui-app
COPY apps/gui-app/package.json apps/gui-app/package-lock.json ./
RUN npm ci
COPY apps/gui-app ./
RUN npm run build

# ---------- Stage 3: native C++ compile ----------
FROM node:20-alpine AS native-build
RUN apk add --no-cache build-base
WORKDIR /build/native
COPY native/cpp ./cpp
RUN g++ -O2 -std=c++17 -o /build/worker cpp/worker.cpp

# ---------- Stage 4: production image ----------
FROM node:20-alpine

LABEL org.opencontainers.image.description="shishan MCP server — Docker image with web console + Streamable HTTP MCP"
LABEL org.opencontainers.image.licenses=MIT

# nginx serves the web page, dumb-init is PID 1, python3 powers the venv,
# libstdc++ is the runtime lib for the compiled C++ worker.
RUN apk add --no-cache nginx dumb-init python3 py3-pip libstdc++ && \
    addgroup -g 1001 -S app && \
    adduser -S app -u 1001

# Isolated Python venv for the MCP tools' python workers.
RUN python3 -m venv /opt/venv

WORKDIR /app

# Backend (dist + prod node_modules)
COPY --from=backend-build /build/backend/dist ./backend/dist
COPY --from=backend-build /build/backend/node_modules ./backend/node_modules
COPY --from=backend-build /build/backend/package.json ./backend/package.json

# Python scripts + pip deps
COPY native/python ./native/python
RUN /opt/venv/bin/pip install --no-cache-dir -r native/python/requirements.txt

# Compiled C++ worker
COPY --from=native-build /build/worker /opt/bin/worker

# Frontend static files (served by nginx)
COPY --from=gui-build /build/gui/dist /usr/share/nginx/html
COPY --from=gui-app-build /build/gui-app/dist /usr/share/nginx/html-app

# nginx + startup
COPY docker/nginx.conf /etc/nginx/http.d/default.conf
COPY docker/start.sh /app/start.sh
RUN chmod +x /app/start.sh

RUN chown -R app:app /app && \
    chown -R app:app /usr/share/nginx/html && \
    chown -R app:app /var/lib/nginx && \
    chown -R app:app /var/log/nginx && \
    chown -R app:app /run/nginx

USER app

EXPOSE 80 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["sh", "/app/start.sh"]
