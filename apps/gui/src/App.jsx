import { useCallback, useEffect, useState } from "react";

function JsonBlock({ label, value }) {
  return (
    <details className="json">
      <summary>{label}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

function ToolCard({ tool }) {
  const schema = tool.inputSchema || {};
  const props = schema.properties || {};
  const required = new Set(schema.required || []);
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const setValue = (key, value) => setValues((s) => ({ ...s, [key]: value }));

  const run = async () => {
    setBusy(true);
    setResult(null);
    setError(null);
    const body = {};
    for (const [key, p] of Object.entries(props)) {
      const raw = values[key];
      if (raw === undefined || raw === "") continue;
      if (p.type === "number" || p.type === "integer") body[key] = Number(raw);
      else if (p.type === "boolean") body[key] = raw === "true";
      else body[key] = raw;
    }
    try {
      const res = await fetch(`/api/run/${tool.name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      setResult(data);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="tool-card">
      <header className="tool-head">
        <code className="tool-name">{tool.name}</code>
      </header>
      <p className="tool-desc">{tool.description}</p>

      {Object.keys(props).length > 0 && (
        <div className="tool-params">
          {Object.entries(props).map(([key, p]) => (
            <label className="param" key={key}>
              <span className="param-label">
                <code>{key}</code>
                {required.has(key) && <em className="req">必填</em>}
                {p.type && <em className="ptype">{p.type}</em>}
              </span>
              <input
                type={p.type === "boolean" ? "checkbox" : "text"}
                placeholder={p.description || p.type}
                checked={p.type === "boolean" ? values[key] === "true" : undefined}
                onChange={(e) =>
                  setValue(
                    key,
                    p.type === "boolean" ? (e.target.checked ? "true" : "false") : e.target.value,
                  )
                }
              />
            </label>
          ))}
        </div>
      )}

      <div className="tool-run">
        <button className="ghost run" onClick={run} disabled={busy}>
          {busy ? "运行中…" : "▶ 运行"}
        </button>
      </div>

      {error && <p className="tool-error">{error}</p>}
      {result !== null && (
        <JsonBlock label="返回 (result)" value={result} />
      )}
      <JsonBlock label="inputSchema（AI 收到的参数定义）" value={tool.inputSchema} />
    </section>
  );
}

export default function App() {
  const [health, setHealth] = useState(null);
  const [tools, setTools] = useState([]);
  const [calls, setCalls] = useState([]);
  const [projects, setProjects] = useState([]);

  const refreshProjects = useCallback(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((data) => setProjects((data.projects || []).map((p) => p.name)))
      .catch(() => setProjects([]));
  }, []);

  const refreshHealth = useCallback(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth({ status: "down" }));
  }, []);

  const refreshTools = useCallback(() => {
    fetch("/api/tools")
      .then((r) => r.json())
      .then((data) => setTools(data.tools || []))
      .catch(() => setTools([]));
  }, []);

  const refreshCalls = useCallback(() => {
    fetch("/api/calls?limit=100")
      .then((r) => r.json())
      .then(setCalls)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshHealth();
    refreshTools();
    refreshCalls();
    refreshProjects();
    const id = setInterval(() => {
      refreshCalls();
      refreshProjects();
    }, 3000);
    return () => clearInterval(id);
  }, [refreshHealth, refreshTools, refreshCalls, refreshProjects]);

  const clearCalls = useCallback(async () => {
    await fetch("/api/calls", { method: "DELETE" });
    refreshCalls();
  }, [refreshCalls]);

  return (
    <div className="page">
      <header className="header">
        <h1>shishan MCP 调试控制台</h1>
        <div className="health">
          <span className={`dot ${health?.status === "ok" ? "ok" : "down"}`} />
          {health?.status === "ok" ? "后端在线" : health ? "后端离线" : "检测中…"}
          {health && health.status === "ok" && (
            <span className="mcp-hint">
              MCP 端点 / · {health.tools.length} 工具 · 功能页 :8081
            </span>
          )}
        </div>
      </header>

      <div className="projects">
        <span className="projects-label">挂载项目</span>
        {projects.length ? (
          projects.map((p) => (
            <span key={p} className="projects-chip">
              {p}
            </span>
          ))
        ) : (
          <span className="muted">—</span>
        )}
      </div>

      <div className="layout">
        <aside className="sidebar">
          <div className="sidebar-head">
            <h2>可用工具</h2>
            <span className="muted">AI 看到的所有内容</span>
          </div>

          {tools.length === 0 ? (
            <p className="muted">没有工具定义（后端离线或未注册）。</p>
          ) : (
            <div className="tool-list">
              {tools.map((t) => (
                <ToolCard key={t.name} tool={t} />
              ))}
            </div>
          )}
        </aside>

        <main className="main">
          <section className="card calls">
            <div className="calls-head">
              <h2>工具调用日志</h2>
              <div className="calls-controls">
                <button className="ghost" onClick={refreshCalls}>
                  刷新
                </button>
                <button className="ghost danger" onClick={clearCalls}>
                  清空
                </button>
              </div>
            </div>

            {calls.length === 0 && (
              <p className="muted">还没有调用记录。让 LLM 客户端调用 MCP 工具试试。</p>
            )}

            <ul className="call-list">
              {calls.map((c) => (
                <li key={c.id} className={`call ${c.status}`}>
                  <div className="call-row">
                    <span className={`source source-${c.source}`}>{c.source}</span>
                    <code className="tool-name">{c.tool}</code>
                    <span className="duration">{c.durationMs}ms</span>
                    <span className={`state ${c.status}`}>{c.status}</span>
                    <time className="time">{new Date(c.timestamp).toLocaleTimeString()}</time>
                  </div>
                  <div className="call-bodies">
                    <JsonBlock label="参数 (params)" value={c.params} />
                    {c.error ? (
                      <JsonBlock label="错误 (error)" value={c.error} />
                    ) : (
                      <JsonBlock label="返回 (result)" value={c.result} />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </main>
      </div>
    </div>
  );
}
