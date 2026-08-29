import { defineConfig } from "vite";

export default defineConfig({
  // 构建时间注入：__BUILD_TIME__ 每次 build/dev 启动自动取当前时间的纪元毫秒，
  // 前端在浏览器本地时区格式化为人类可读时间（避免容器 UTC 时区误差）
  define: {
    __BUILD_TIME__: JSON.stringify(Date.now()),
  },
  server: {
    port: 5175,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});