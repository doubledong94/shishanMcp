import { useCallback, useEffect, useState } from "react";

export default function App() {
  const [connected, setConnected] = useState(false);
  const [file, setFile] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [projects, setProjects] = useState([]);

  const refresh = useCallback(() => {
    fetch("/api/code")
      .then((r) => r.json())
      .then((data) => {
        setConnected(true);
        setFile(data.file);
        if (data.file) setUpdatedAt(data.file.updatedAt);
      })
      .catch(() => {
        setConnected(false);
        setFile(null);
      });
    fetch("/api/projects")
      .then((r) => r.json())
      .then((data) => setProjects((data.projects || []).map((p) => p.name)))
      .catch(() => setProjects([]));
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <div className="page">
      <header className="header">
        <h1>MCP 功能页 · 代码查看</h1>
        <span className={`conn ${connected ? "ok" : "down"}`}>
          <span className="dot" />
          {connected ? "后端在线" : "后端离线"}
        </span>
      </header>

      {projects.length > 0 && (
        <div className="projects">
          <span className="projects-label">挂载项目</span>
          {projects.map((p) => (
            <span key={p} className="projects-chip">
              {p}
            </span>
          ))}
        </div>
      )}

      {!connected ? (
        <p className="empty">后端离线，无法连接。</p>
      ) : !file ? (
        <p className="empty">
          还没有文件。让 AI 调用 MCP 的 <code>read_file</code> 工具读一个文件，
          这里会实时展示 AI 正在看的代码。
        </p>
      ) : (
        <div className="file">
          <div className="file-head">
            <span className="lang">{file.language}</span>
            <span className="filename">{file.filename}</span>
            <time>{updatedAt ? new Date(updatedAt).toLocaleString() : ""}</time>
          </div>
          <pre className="code">
            <code>{file.code}</code>
          </pre>
        </div>
      )}
    </div>
  );
}
