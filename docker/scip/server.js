/**
 * scip 网关 —— 生成 index.scip 并转 JSON 的独立 docker 服务。
 *
 * 对外 API（与 backend 的 ScipClientService 对应）：
 *   POST /api/jobs             {project, language} -> {jobId}
 *   GET  /api/jobs/:id         -> {id,status,project,language,indexPath,error}
 *   GET  /api/index/:project   -> index.scip 的 JSON 表示
 *   GET  /api/health           -> ok + 可用 indexer 列表
 *
 * 设计要点：
 *  - 项目采用宿主机同路径挂载（容器内路径 = 宿主机路径），项目列表由
 *    SCIP_PROJECTS（冒号分隔的绝对路径）提供；项目名 = 目录名。
 *  - 项目挂载是只读的，而 scip indexer 需要读写依赖和可能生成 tsconfig，
 *    因此执行前把源码拷贝到工作目录 <DATA_ROOT>/<project>/work。
 *  - 产物统一写到 <DATA_ROOT>/<project>/index.scip，经 /api/index 转 JSON 供 MCP 读取。
 *  - 用本体自带标准 http，零第三方依赖。
 */

const http = require("node:http");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/** 挂载的项目绝对路径列表（容器内 = 宿主机路径）。 */
const PROJECTS = parseProjects(process.env.SCIP_PROJECTS);
const DATA_ROOT = process.env.SCIP_DATA_ROOT || "/data/scip";

function parseProjects(raw) {
  if (!raw) return [];
  return raw
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 按项目名（目录名）解析项目绝对路径；不存在返回 null。 */
function projectDir(name) {
  const found = PROJECTS.find((p) => path.basename(p) === name);
  return found || null;
}

/** 每个语言的索引器命令（cwd = 工作目录）。返回 {cmd, args}[]。 */
function indexerFor(language, projectName) {
  const map = {
    typescript: () => [
      { cmd: "scip-typescript", args: ["index", "--infer-tsconfig", "--no-global-caches"] },
    ],
    typescriptreact: () => [
      { cmd: "scip-typescript", args: ["index", "--infer-tsconfig", "--no-global-caches"] },
    ],
    javascript: () => [
      { cmd: "scip-typescript", args: ["index", "--infer-tsconfig", "--no-global-caches"] },
    ],
    javascriptreact: () => [
      { cmd: "scip-typescript", args: ["index", "--infer-tsconfig", "--no-global-caches"] },
    ],
    python: (p) => [
      { cmd: "npm", args: ["install"] }, // 允许项目有依赖（已 fail-fast）
      { cmd: "scip-python", args: ["index", ".", "--project-name", p] },
    ],
    go: (p) => [
      { cmd: "scip-go", args: ["index", ".", "--project-name", p] },
    ],
    // scip-java 是 JVM fat-jar，支持 Java/Scala/Kotlin（Gradle/Maven 项目）
    java: () => [{ cmd: "scip-java", args: ["index"] }],
    scala: () => [{ cmd: "scip-java", args: ["index"] }],
    kotlin: () => [{ cmd: "scip-java", args: ["index"] }],
    // scip-clang 需要项目先有 compile_commands.json（编译数据库）
    c: () => clangSteps(),
    cpp: () => clangSteps(),
    "c++": () => clangSteps(),
    rust: () => [{ cmd: "rust-analyzer", args: ["scip", "."] }],
    ruby: () => [{ cmd: "scip-ruby", args: ["index", "."] }],
    csharp: (p) => [{ cmd: "scip-dotnet", args: ["index"] }],
  };
  const fn = map[language.toLowerCase()];
  if (!fn) return null;
  return fn(projectName);
}

/** scip-clang：从项目根运行，读编译数据库产出 index.scip。 */
function clangSteps() {
  return [
    { cmd: "scip-clang", args: ["--compdb-path=compile_commands.json"] },
  ];
}

function isClang(language) {
  const l = String(language).toLowerCase();
  return l === "c" || l === "cpp" || l === "c++";
}

function isJvm(language) {
  const l = String(language).toLowerCase();
  return l === "java" || l === "scala" || l === "kotlin";
}

/** 用 command -v 检查命令是否在 PATH（scip 容器里常见场景）。 */
function which(cmd) {
  return new Promise((resolve) => {
    const proc = spawn("sh", ["-c", `command -v ${cmd}`], { stdio: ["ignore", "pipe", "ignore"] });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

// ---------------- 工具函数 ----------------

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "dist")
      continue;
    const src = path.join(from, ent.name);
    const dst = path.join(to, ent.name);
    if (ent.isDirectory()) copyTree(src, dst);
    else if (ent.isFile()) fs.copyFileSync(src, dst);
  }
}

function safeProjectName(name) {
  return /^[\w.-]+$/.test(name) ? name : null;
}

/** 在工作目录里找生成的 index.scip（可能嵌套在子目录）。 */
function findScipFile(workDir) {
  const candidates = [
    path.join(workDir, "index.scip"),
    path.join(workDir, ".scip", "index.scip"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  const hit = walkScip(workDir);
  return hit || null;
}

function walkScip(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const found = walkScip(full);
      if (found) return found;
    } else if (e.name === "index.scip") {
      return full;
    }
  }
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("invalid json body"));
      }
    });
    req.on("error", reject);
  });
}

function json(res, code, obj) {
  const text = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

/** 运行命令序列，失败即中止并返回错误。同时把子进程输出实时 tee 到
 *  <工作目录>/../build.log（即 <DATA_ROOT>/<project>/build.log，同路径挂载，
 *  宿主机可直接 tail -f 流式查看编译进度）。
 */
function runSteps(steps, cwd) {
  return new Promise((resolve, reject) => {
    let i = 0;
    const logs = [];
    const logFile = path.resolve(cwd, "..", "build.log");
    fs.writeFileSync(logFile, "");
    const next = () => {
      if (i >= steps.length) return resolve(logs.join("\n"));
      const { cmd, args } = steps[i++];
      // scip-java 聚合阶段要读回全部 .tree 语法树（okhttp 有数百 MB），默认 JVM 堆（容器内存 25%）
      // 不够，索引大项目给足堆。
      const env =
        cmd === "scip-java"
          ? { ...process.env, SCIP_JAVA_OPTS: "-Xmx6g" }
          : process.env;
      const proc = spawn(cmd, args, { cwd, shell: false, env });
      let out = "";
      proc.stdout.on("data", (d) => {
        out += d;
        fs.appendFileSync(logFile, d);
      });
      proc.stderr.on("data", (d) => {
        out += d;
        fs.appendFileSync(logFile, d);
      });
      proc.on("error", (err) =>
        reject(new Error(`无法启动 ${cmd}: ${err.message}\n${out}`)),
      );
      proc.on("close", (code) => {
        out = out.trim();
        if (out) logs.push(`$ ${cmd} ${args.join(" ")}\n${out}`);
        if (code !== 0) {
          return reject(new Error(`命令失败（exit ${code}）: ${cmd} ${args.join(" ")}\n${out}`));
        }
        next();
      });
    };
    next();
  });
}

// ---------------- 任务执行（同步串行，网关够用） ----------------

const jobs = new Map();

async function dispatch(project, language, jobId) {
  const outDir = path.join(DATA_ROOT, project);
  const workDir = path.join(outDir, "work");
  const indexPath = path.join(outDir, "index.scip");
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  const job = () => jobs.get(jobId);
  try {
    const steps = indexerFor(language, project);
    if (!steps) throw new Error(`scip 不支持的语言: ${language}`);
    const srcDir = projectDir(project);
    if (!srcDir || !fs.existsSync(srcDir)) {
      throw new Error(`项目不存在：${project}（SCIP_PROJECTS 里没有该目录名）`);
    }
    setJob(jobId, { status: "running" });
    copyTree(srcDir, workDir);
    // JVM 项目：删除 gradlew，强制 scip-java 用 PATH 里的系统 Gradle（预装 9.6.1），
    // 从而跳过 wrapper 发行版下载（services.gradle.org 在国内被墙，下载会卡死）。
      // 同时写 gradle.properties 声明预装 JDK21/JDK11 的 toolchain 路径，避免 Gradle 尝试
      // "toolchain 自动下载"（国内无下载源，会报 No defined toolchain download url）。
      // JDK11 是给 okhttp 等项目的 compileJavaModuleInfo（硬编码 11）用的，见
      // doc/gradle-compat-guide.md 4.3。
    if (isJvm(language)) {
      for (const f of ["gradlew", "gradlew.bat", ".gradle"]) {
        const p = path.join(workDir, f);
        if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
      }
      const gp = path.join(workDir, "gradle.properties");
      let content = "";
      if (fs.existsSync(gp)) content = fs.readFileSync(gp, "utf8") + "\n";
      content += "org.gradle.java.installations.paths=/opt/jdk21,/opt/jdk11\norg.gradle.java.installations.auto-download=false\n";
      fs.writeFileSync(gp, content);
    }
    // scip-clang 需要编译数据库（compile_commands.json）才能索引 C/C++，提前给出可读报错
    if (isClang(language) && !fs.existsSync(path.join(workDir, "compile_commands.json"))) {
      throw new Error(
        `scip-clang 需要 ${project} 根目录存在 compile_commands.json（编译数据库）。` +
          `请先用 CMake -DCMAKE_EXPORT_COMPILE_COMMANDS=ON 或 bear 生成后再重试。`,
      );
    }
    // indexer 二进制是否已安装（避免"command not found"这类难读错误）
    const first = steps[0].cmd;
    const hasBin = await which(first);
    if (!hasBin) {
      throw new Error(`indexer 未安装：${first}（镜像里没有，需要在 docker/scip/Dockerfile 补装）`);
    }
    const log = await runSteps(steps, workDir);
    // 产物默认写在 cwd（工作目录），移到索引目录
    const produced = findScipFile(workDir);
    if (!produced) throw new Error(`indexer 未生成 index.scip\n${log}`);
    fs.copyFileSync(produced, indexPath);
    setJob(jobId, {
      status: "done",
      indexPath,
      lastLog: log.slice(-2000),
    });
  } catch (err) {
    setJob(jobId, { status: "failed", error: err.message });
    throw err;
  }
}

function setJob(id, patch) {
  const cur = jobs.get(id) || {};
  jobs.set(id, { ...cur, ...patch });
}

function createJob(project, language) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  jobs.set(id, { id, status: "pending", project, language });
  return id;
}

// ---------------- HTTP 路由 ----------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  try {
    if (req.method === "POST" && pathname === "/api/jobs") {
      const body = await readBody(req);
      const project = safeProjectName(body.project);
      const language = String(body.language || "").trim();
      if (!project) return json(res, 400, { error: "invalid or missing project" });
      if (!indexerFor(language, project)) {
        return json(res, 400, { error: `scip 不支持的语言: ${language}` });
      }
      const jobId = createJob(project, language);
      // 异步执行，立即返回
      Promise.resolve()
        .then(() => dispatch(project, language, jobId))
        .catch(() => {
          /* 错误已写回状态 */
        });
      return json(res, 202, { jobId });
    }

    const jobsMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (req.method === "GET" && jobsMatch) {
      const job = jobs.get(jobsMatch[1]);
      if (!job) return json(res, 404, { error: "job not found" });
      return json(res, 200, job);
    }

    const indexMatch = pathname.match(/^\/api\/index\/([^/]+)$/);
    if (req.method === "GET" && indexMatch) {
      const project = safeProjectName(decodeURIComponent(indexMatch[1]));
      if (!project) return json(res, 400, { error: "invalid project" });
      // 优先读 <project>/index.scip（网关 job 产物）；没有则回退到
      // <project>/work/index.scip（手动流程 / 老产物也可能落在这里）。
      const indexPath =
        fs.existsSync(path.join(DATA_ROOT, project, "index.scip"))
          ? path.join(DATA_ROOT, project, "index.scip")
          : path.join(DATA_ROOT, project, "work", "index.scip");
      if (!fs.existsSync(indexPath)) {
        return json(res, 404, { error: `index.scip 不存在: ${project}（先调用 POST /api/jobs）` });
      }
      // 用 scip print --json 转 protobuf -> JSON
      const proc = spawn("scip", ["print", "--json", indexPath], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      proc.stdout.on("data", (d) => (out += d));
      proc.stderr.on("data", (d) => (out += d));
      proc.on("error", (err) => json(res, 500, { error: `scip CLI 不可用: ${err.message}` }));
      proc.on("close", (code) => {
        if (code !== 0) return json(res, 500, { error: out.slice(0, 500) || "scip print 失败" });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(out);
      });
      return;
    }

   if (req.method === "GET" && pathname === "/api/health") {
     const indexers = ["scip", "scip-typescript", "scip-python", "scip-java", "scip-clang"];
     return json(res, 200, {
       status: "ok",
       scip: "available",
       dataRoot: DATA_ROOT,
       indexers: indexers.filter((c) => fs.existsSync(`/usr/local/bin/${c}`) || fs.existsSync(`/usr/bin/${c}`)),
     });
   }

    json(res, 404, { error: "not found" });
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

const PORT = Number(process.env.PORT || 8000);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`scip gateway listening on :${PORT}`);
  console.log(`projects=${PROJECTS.join(":") || "(空，需设置 SCIP_PROJECTS)"}  data=${DATA_ROOT}`);
});