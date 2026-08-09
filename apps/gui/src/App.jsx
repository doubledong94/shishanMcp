import { useCallback, useEffect, useMemo, useState } from "react";

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

function fmtRange(occ) {
  const single = occ.TypedRange?.SingleLineRange;
  if (single) {
    return `${single.line + 1}:${single.start_character + 1}–${single.end_character + 1}`;
  }
  const multi = occ.TypedRange?.MultiLineRange;
  if (multi) {
    return `${multi.start_line + 1}:${multi.start_character + 1}–${multi.end_line + 1}:${multi.end_character + 1}`;
  }
  return "";
}

function fmtEnclosingRange(occ) {
  const e = occ.TypedEnclosingRange;
  if (!e) return null;
  const single = e.SingleLineRange ?? e.SingleLineEnclosingRange;
  if (single) {
    return `enclosing ${single.line + 1}:${single.start_character + 1}–${single.end_character + 1}`;
  }
  const multi = e.MultiLineRange ?? e.MultiLineEnclosingRange;
  if (multi) {
    const sc = (multi.start_character ?? 0) + 1;
    const ec = (multi.end_character ?? 0) + 1;
    return `enclosing ${multi.start_line + 1}:${sc}–${multi.end_line + 1}:${ec}`;
  }
  return null;
}

const SCIP_ROLES = [
  [0x1, "Definition"],
  [0x2, "Import"],
  [0x4, "WriteAccess"],
  [0x8, "ReadAccess"],
  [0x10, "Generated"],
  [0x20, "Test"],
  [0x40, "ForwardDefinition"],
];

function fmtRoles(roles) {
  if (!roles) return "";
  return SCIP_ROLES.filter(([bit]) => roles & bit)
    .map(([, name]) => name)
    .join(" | ");
}

const SYNTAX_NAMES = {
  1: "Comment",
  2: "PunctuationDelimiter",
  3: "PunctuationBracket",
  4: "Keyword",
  5: "IdentifierOperator",
  6: "Identifier",
  7: "IdentifierBuiltin",
  8: "IdentifierNull",
  9: "IdentifierConstant",
  10: "IdentifierMutableGlobal",
  11: "IdentifierParameter",
  12: "IdentifierLocal",
  13: "IdentifierShadowed",
  14: "IdentifierNamespace",
  15: "IdentifierFunction",
  16: "IdentifierFunctionDefinition",
  17: "IdentifierMacro",
  18: "IdentifierMacroDefinition",
  19: "IdentifierType",
  20: "IdentifierBuiltinType",
  21: "IdentifierAttribute",
  22: "RegexEscape",
  23: "RegexRepeated",
  24: "RegexWildcard",
  25: "RegexDelimiter",
  26: "RegexJoin",
  27: "StringLiteral",
  28: "StringLiteralEscape",
  29: "StringLiteralSpecial",
  30: "StringLiteralKey",
  31: "CharacterLiteral",
  32: "NumericLiteral",
  33: "BooleanLiteral",
  34: "Tag",
  35: "TagAttribute",
  36: "TagDelimiter",
};

function kindName(kind) {
  const names = {
    1: "Array", 2: "Assertion", 3: "AssociatedType", 4: "Attribute", 5: "Axiom",
    6: "Boolean", 7: "Class", 8: "Constant", 9: "Constructor", 10: "DataFamily",
    11: "Enum", 12: "EnumMember", 13: "Event", 14: "Fact", 15: "Field",
    16: "File", 17: "Function", 18: "Getter", 19: "Grammar", 20: "Instance",
    21: "Interface", 22: "Key", 23: "Lang", 24: "Lemma", 25: "Macro",
    26: "Method", 27: "MethodReceiver", 28: "Message", 29: "Module", 30: "Namespace",
    31: "Null", 32: "Number", 33: "Object", 34: "Operator", 35: "Package",
    36: "PackageObject", 37: "Parameter", 38: "ParameterLabel", 39: "Pattern", 40: "Predicate",
    41: "Property", 42: "Protocol", 43: "Quasiquoter", 44: "SelfParameter", 45: "Setter",
    46: "Signature", 47: "Subscript", 48: "String", 49: "Struct", 50: "Tactic",
    51: "Theorem", 52: "ThisParameter", 53: "Trait", 54: "Type", 55: "TypeAlias",
    56: "TypeClass", 57: "TypeFamily", 58: "TypeParameter", 59: "Union", 60: "Value",
    61: "Variable", 62: "Contract", 63: "Error", 64: "Library", 65: "Modifier",
    66: "AbstractMethod", 67: "MethodSpecification", 68: "ProtocolMethod", 69: "PureVirtualMethod",
    70: "TraitMethod", 71: "TypeClassMethod", 72: "Accessor", 73: "Delegate", 74: "MethodAlias",
    75: "SingletonClass", 76: "SingletonMethod", 77: "StaticDataMember", 78: "StaticEvent",
    79: "StaticField", 80: "StaticMethod", 81: "StaticProperty", 82: "StaticVariable",
    84: "Extension", 85: "Mixin", 86: "Concept",
  };
  return names[kind] ?? (kind != null ? `#${kind}` : null);
}

const REL_LABELS = [
  ["is_reference", "reference"],
  ["is_implementation", "implementation"],
  ["is_type_definition", "type definition"],
  ["is_definition", "definition"],
];

function ScipRelationshipRow({ r }) {
  const flags = REL_LABELS.filter(([k]) => r[k]).map(([, label]) => label);
  return (
    <li className="scip-rel" title="SymbolInformation.relationships[i]">
      <span className="scip-rel-flags" title="Relationship 布尔标记（is_reference/is_implementation/is_type_definition/is_definition）">
        {flags.length ? flags.join(", ") : "—"}
      </span>
      <span className="scip-field-label" title="Relationship.symbol">symbol</span>
      <code className="scip-symbol-full" title="Relationship.symbol">{r.symbol}</code>
    </li>
  );
}

function ScipSymbolRow({ s, index }) {
  const name = s.display_name || shortSymbol(s.symbol);
  const k = kindName(s.kind);
  return (
    <li className="scip-symbol" title="SymbolInformation（Document.symbols[i]）">
      <div className="scip-symbol-card-head">
        <span className="scip-symbol-tag" title="列表序号（UI 辅助，非协议字段）">
          SymbolInformation #{index + 1}
        </span>
        <code className="scip-symbol-name" title="SymbolInformation.display_name">
          {name}
        </code>
        {k && (
          <span className="scip-symbol-kind" title="SymbolInformation.kind（enum）">
            {k}
          </span>
        )}
        {s.signature_documentation?.text && (
          <code
            className="scip-symbol-sig"
            title="SymbolInformation.signature_documentation {language, text}"
          >
            {s.signature_documentation.language
              ? `[${s.signature_documentation.language}] `
              : ""}
            {s.signature_documentation.text}
          </code>
        )}
      </div>
      <div className="scip-symbol-full-row">
        <span className="scip-field-label" title="SymbolInformation.symbol">
          symbol
        </span>
        <code className="scip-symbol-full">{s.symbol}</code>
      </div>
      {s.enclosing_symbol && (
        <div className="scip-symbol-full-row" title="SymbolInformation.enclosing_symbol">
          <span className="scip-field-label">enclosing symbol</span>
          <code className="scip-symbol-full">{s.enclosing_symbol}</code>
        </div>
      )}
      {s.relationships?.length > 0 && (
        <details className="scip-inner">
          <summary title="SymbolInformation.relationships">relationships（{s.relationships.length}）</summary>
          <ul className="scip-rels">
            {s.relationships.map((r, i) => (
              <ScipRelationshipRow key={i} r={r} />
            ))}
          </ul>
        </details>
      )}
      {s.documentation?.length > 0 && (
        <details className="scip-inner">
          <summary title="SymbolInformation.documentation">文档</summary>
          <p className="scip-symbol-doc">{s.documentation.join(" ")}</p>
        </details>
      )}
    </li>
  );
}

function ScipOccRow({ occ, index }) {
  const roles = fmtRoles(occ.symbol_roles);
  const enclosing = fmtEnclosingRange(occ);
  const syntax = occ.syntax_kind != null ? (SYNTAX_NAMES[occ.syntax_kind] ?? `#${occ.syntax_kind}`) : null;
  const diags = occ.diagnostics?.length ? occ.diagnostics : null;
  const override = occ.override_documentation?.length ? occ.override_documentation : null;
  return (
    <li className="scip-occ" title="Occurrence（Document.occurrences[i]）">
      <div className="scip-symbol-card-head">
        <span className="scip-occ-tag-label" title="列表序号（UI 辅助，非协议字段）">
          Occurrence #{index + 1}
        </span>
        <span className="scip-occ-loc" title="Occurrence.typed_range（single_line_range / multi_line_range）">
          {fmtRange(occ)}
        </span>
        <code className="scip-symbol-name" title="Occurrence.symbol">
          {shortSymbol(occ.symbol)}
        </code>
      </div>
      <div className="scip-occ-tags">
        {roles && (
          <span className="scip-occ-tag" title="Occurrence.symbol_roles（SymbolRole 位掩码）">
            roles: {roles}
          </span>
        )}
        {syntax && (
          <span className="scip-occ-tag" title="Occurrence.syntax_kind（SyntaxKind enum）">
            syntax: {syntax}
          </span>
        )}
        {enclosing && (
          <span className="scip-occ-tag" title="Occurrence.typed_enclosing_range">
            {enclosing}
          </span>
        )}
      </div>
      {override && (
        <details className="scip-inner">
          <summary title="Occurrence.override_documentation">override documentation</summary>
          <p className="scip-symbol-doc">{override.join(" ")}</p>
        </details>
      )}
      {diags && (
        <details className="scip-inner">
          <summary title="Occurrence.diagnostics">diagnostics（{diags.length}）</summary>
          <ul className="scip-diags">
            {diags.map((dg, i) => (
              <li key={i} className="scip-diag">
                <span className="scip-diag-msg" title="Diagnostic.message">{dg.message}</span>
                {dg.code && <code className="scip-occ-tag" title="Diagnostic.code">code: {dg.code}</code>}
                {dg.severity != null && (
                  <code className="scip-occ-tag" title="Diagnostic.severity">severity: {dg.severity}</code>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

function ScipDocView({ doc }) {
  const posEnc =
    doc.position_encoding != null
      ? { 0: "Unspecified", 1: "UTF8", 2: "UTF16", 3: "UTF32" }[doc.position_encoding] ??
        `#${doc.position_encoding}`
      : null;
  const noCoordCount = (doc.symbols || []).filter((s) => noCoord(s.symbol)).length;
  return (
    <div className={`scip-doc-view ${noCoordCount ? "has-no-coord" : ""}`}>
      {noCoordCount > 0 && (
        <p className="scip-no-coord-banner" title="SymbolInformation.symbol 的 maven 坐标为空（package-name/version 为占位符 `.`）">
          该文档有 {noCoordCount} 个符号缺少 maven 坐标（package-name/version 为 `.`），
          多来自 samples/test 等非发布模块。
        </p>
      )}
      <div className="scip-doc-meta">
        <code title="Document.language">{doc.language}</code>
        {posEnc && (
          <span className="scip-occ-tag" title="Document.position_encoding">
            position encoding: {posEnc}
          </span>
        )}
        <span className="muted" title="Document.relative_path">
          {doc.relative_path}
        </span>
      </div>

      {doc.text && (
        <details className="scip-inner" open>
          <summary title="Document.text">源码 (text)</summary>
          <pre className="scip-doc-text">{doc.text}</pre>
        </details>
      )}

      <details className="scip-inner">
        <summary title="Document.symbols">symbols（{doc.symbols?.length ?? 0}）</summary>
        {doc.symbols?.length ? (
          <ul className="scip-symbols">
            {doc.symbols.map((s, i) => (
              <ScipSymbolRow key={i} s={s} index={i} />
            ))}
          </ul>
        ) : (
          <span className="muted">（无）</span>
        )}
      </details>

      <details className="scip-inner">
        <summary title="Document.occurrences">occurrences（{doc.occurrences?.length ?? 0}）</summary>
        {doc.occurrences?.length ? (
          <ul className="scip-occs">
            {doc.occurrences.map((o, i) => (
              <ScipOccRow key={i} occ={o} index={i} />
            ))}
          </ul>
        ) : (
          <span className="muted">（无）</span>
        )}
      </details>
    </div>
  );
}

function shortSymbol(s) {
  if (!s) return "";
  // SCIP local 符号形如 "local 3"：匿名无名字，显示占位说明而非裸数字
  if (s.startsWith("local ")) return `<local #${s.slice(6)}>`;
  const parts = s.split(" ");
  return parts[parts.length - 1] || s;
}

/** SCIP symbol 的 maven 坐标是否为空（package-name / version 为占位符 `.`）。 */
function noCoord(s) {
  if (!s) return false;
  const parts = s.split(" ");
  return parts.length >= 4 && (parts[2] === "." || parts[3] === ".");
}

/** doc.symbols 中是否存在空坐标 symbol。 */
function docHasNoCoordSymbols(symbols) {
  return (symbols || []).some((s) => noCoord(s.symbol));
}

function ScipIndexViewer({ projects }) {
  const [project, setProject] = useState("");
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [openDocs, setOpenDocs] = useState({});
  const [docCache, setDocCache] = useState({});
  const projectNames = [...new Set(projects)];

  const loadSummary = useCallback(async (p) => {
    setProject(p);
    setSummary(null);
    setDocCache({});
    setOpenDocs({});
    setError(null);
    if (!p) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/scip-index/${encodeURIComponent(p)}/summary`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setSummary(await res.json());
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const toggleDoc = useCallback(
    async (relPath) => {
      if (openDocs[relPath]) {
        setOpenDocs((s) => ({ ...s, [relPath]: !s[relPath] }));
        return;
      }
      setOpenDocs((s) => ({ ...s, [relPath]: true }));
      if (docCache[relPath]) return;
      try {
        const res = await fetch(
          `/api/scip-index/${encodeURIComponent(project)}/document?path=${encodeURIComponent(relPath)}`,
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        setDocCache((s) => ({ ...s, [relPath]: data.document }));
      } catch (e) {
        setDocCache((s) => ({ ...s, [relPath]: { error: e.message } }));
      }
    },
    [project, openDocs, docCache],
  );

  return (
    <section className="card scip-viewer">
      <header className="calls-head">
        <h2>SCIP 索引查看器</h2>
        <select
          className="scip-project"
          value={project}
          onChange={(e) => loadSummary(e.target.value)}
        >
          <option value="">选择项目…</option>
          {projectNames.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </header>

      {error && <p className="scip-error">{error}</p>}
      {loading && <p className="muted">加载索引概览…（首次访问需解析全量索引）</p>}

      {summary && (
        <div className="scip-meta">
          <span title="metadata.tool_info.name">
            tool: <code>{summary.tool || "—"}</code>
          </span>
          <span title="metadata.tool_info.version">v{summary.toolVersion || "?"}</span>
          <span title="documents.length">
            文档: <b>{summary.documents.length}</b>
          </span>
          <span title="external_symbols.length">
            外部符号: <b>{summary.externalSymbols}</b>
          </span>
          {summary.protocolVersion !== undefined && (
            <span title="metadata.version">
              协议版本: <b>{summary.protocolVersion}</b>
            </span>
          )}
          {summary.textEncoding && (
            <span title="metadata.text_document_encoding">
              text encoding: <b>{summary.textEncoding}</b>
            </span>
          )}
          {summary.projectRoot && (
            <span className="muted" title="metadata.project_root">
              {summary.projectRoot}
            </span>
          )}
          {summary.toolArguments?.length > 0 && (
            <span className="scip-meta-args" title="metadata.tool_info.arguments">
              参数: <code>{summary.toolArguments.join(" ")}</code>
            </span>
          )}
        </div>
      )}

      {summary && (
        <ul className="scip-doc-list">
          {summary.documents.map((d) => {
            const open = !!openDocs[d.relative_path];
            const cached = docCache[d.relative_path];
            return (
              <li key={d.relative_path}>
                <button
                  className={`scip-doc-toggle ${open ? "open" : ""} ${d.noCoordSymbols ? "has-no-coord" : ""}`}
                  onClick={() => toggleDoc(d.relative_path)}
                >
                  <span className="caret">{open ? "▾" : "▸"}</span>
                  <code className="scip-doc-path" title="Document.relative_path">
                    {d.relative_path}
                  </code>
                  <span className="scip-doc-lang" title="Document.language">
                    {d.language}
                  </span>
                  {d.noCoordSymbols > 0 && (
                    <span className="scip-no-coord-tag" title="SymbolInformation.symbol 的 maven 坐标为空（package-name/version 为 `.`）">
                      无坐标 {d.noCoordSymbols}
                    </span>
                  )}
                  <span className="muted" title="Document.occurrences.length">
                    {d.occurrences} occ
                  </span>
                </button>
                {open && (
                  <div className="scip-doc-body">
                    {cached === undefined ? (
                      <span className="muted">加载中…</span>
                    ) : cached?.error ? (
                      <span className="scip-error">{cached.error}</span>
                    ) : (
                      <ScipDocView doc={cached} />
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!project && !error && (
        <p className="muted">选择一个挂载项目查看 SCIP 索引的结构与内容。</p>
      )}
    </section>
  );
}

function AstNodeRow({ node, depth, source, matchIndex, activeOcc, onMatch }) {
  const [open, setOpen] = useState(depth < 2);
  const hasChildren = node.children?.length > 0;
  const range = node.name ? `${node.kind} «${node.name}»` : node.kind;
  const snippet =
    source && node.end > node.start
      ? source.slice(node.start, node.end)
      : null;
  const hit = matchesForNode(node, matchIndex);
  const isActive = activeOcc !== null && hit && hit.includes(activeOcc);
  const matched = hit ? `${hit.length} occ` : null;

  const handleMatch = (e) => {
    e.stopPropagation();
    if (!hit) return;
    // 多个匹配时循环切换
    const idx = hit.indexOf(activeOcc);
    const next = idx >= 0 ? hit[(idx + 1) % hit.length] : hit[0];
    onMatch(next);
  };

  return (
    <div className="ast-node" style={{ paddingLeft: `${depth * 8}px` }}>
      {hasChildren ? (
        <button className="ast-toggle" onClick={() => setOpen(!open)}>
          <span className="caret">{open ? "▾" : "▸"}</span>
          <code className="ast-kind">{range}</code>
          {snippet !== null && snippet.length <= 40 && (
            <code className="ast-snippet">{snippet}</code>
          )}
          <span className="muted">
            [{node.start}–{node.end}]
          </span>
        </button>
      ) : (
        <div className={`ast-leaf ${isActive ? "ast-leaf-active" : ""}`}>
          <span className="caret muted">·</span>
          <code className="ast-kind">{range}</code>
          {snippet !== null && snippet.length <= 40 && (
            <code className="ast-snippet">{snippet}</code>
          )}
          <span className="muted">[{node.start}–{node.end}]</span>
          {hit && (
            <button
              className="ast-match-btn"
              title={hit.map((o) => o.symbol).join("\n")}
              onClick={handleMatch}
            >
              {matched}
            </button>
          )}
          {isActive && activeOcc && (
            <span className="ast-match-symbol" title={activeOcc.symbol}>
              {shortSymbol(activeOcc.symbol)}
            </span>
          )}
        </div>
      )}
      {isActive && activeOcc && source && (
        <div
          className="ast-source-preview"
          style={{ paddingLeft: `${(depth + 1) * 8}px` }}
        >
          <code className="ast-source-window">
            {(() => {
              const w = codeWindow(source, activeOcc.byteRange[0], activeOcc.byteRange[1]);
              return (
                <>
                  <span className="ast-src-pre">{w.head}</span>
                  <span
                    className="ast-src-hit"
                    title={`byte[${activeOcc.byteRange[0]},${activeOcc.byteRange[1]})`}
                  >
                    {w.seg}
                  </span>
                  <span className="ast-src-post">{w.tail}</span>
                </>
              );
            })()}
          </code>
        </div>
      )}
      {open &&
        hasChildren &&
        node.children.map((c, i) => (
          <AstNodeRow
            key={i}
            node={c}
            depth={depth + 1}
            source={source}
            matchIndex={matchIndex}
            activeOcc={activeOcc}
            onMatch={onMatch}
          />
        ))}
    </div>
  );
}

/** 命中 occurrence 索引：byteRange -> occurrence[]（一个区间可能对应多个符号）。 */
function matchesForNode(node, matchIndex) {
  if (!matchIndex || matchIndex.size === 0) return null;
  return matchIndex.get(`${node.start}:${node.end}`) || null;
}

/**
 * 取 byteRange 附近的源码窗口（字节偏移），返回左/命中/右三段。
 * 用 TextEncoder 把源文本字节化，按字节偏移切片，再 UTF-8 解码片段，
 * 避免字节坐标直接当字符索引导致中文错位。
 */
function codeWindow(source, bStart, bEnd, pad = 90) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const bytes = enc.encode(source);
  const hi = Math.min(bEnd, bytes.length);
  const lo = Math.max(0, Math.min(bStart, hi));
  return {
    head: dec.decode(bytes.slice(Math.max(0, lo - pad), lo)),
    seg: dec.decode(bytes.slice(lo, hi)),
    tail: dec.decode(bytes.slice(hi, Math.min(bytes.length, hi + pad))),
  };
}

function AstTreeView({ ast, source, occurrences }) {
  const [activeOcc, setActiveOcc] = useState(null);
  const matchIndex = useMemo(() => {
    const m = new Map();
    if (occurrences) {
      for (const occ of occurrences) {
        const key = `${occ.byteRange[0]}:${occ.byteRange[1]}`;
        const list = m.get(key);
        if (list) list.push(occ);
        else m.set(key, [occ]);
      }
    }
    return m;
  }, [occurrences]);
  return (
    <div className="ast-tree-view">
      <div className="scip-doc-meta">
        <code>{ast.language}</code>
        <span className="muted">{ast.path}</span>
        <span className="ast-errors">errors: {ast.errorCount}</span>
        {source && <span className="muted">{source.length} 字符</span>}
        {occurrences && (
          <span className="muted">
            {occurrences.length} occurrences 可匹配
          </span>
        )}
      </div>
      {ast.nodes.map((n, i) => (
        <AstNodeRow
          key={i}
          node={n}
          depth={0}
          source={source}
          matchIndex={matchIndex}
          activeOcc={activeOcc}
          onMatch={setActiveOcc}
        />
      ))}
    </div>
  );
}

function AstViewer({ projects }) {
  const [project, setProject] = useState("");
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [openFiles, setOpenFiles] = useState({});
  const [treeCache, setTreeCache] = useState({});
  const projectNames = [...new Set(projects)];

  const loadSummary = useCallback(async (p) => {
    setProject(p);
    setSummary(null);
    setTreeCache({});
    setOpenFiles({});
    setError(null);
    if (!p) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/ast/${encodeURIComponent(p)}/summary`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setSummary(await res.json());
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const toggleFile = useCallback(
    async (astPath) => {
      if (openFiles[astPath]) {
        setOpenFiles((s) => ({ ...s, [astPath]: !s[astPath] }));
        return;
      }
      setOpenFiles((s) => ({ ...s, [astPath]: true }));
      if (treeCache[astPath]) return;
      try {
        const res = await fetch(
          `/api/ast/${encodeURIComponent(project)}/tree?ast=${encodeURIComponent(astPath)}`,
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        setTreeCache((s) => ({ ...s, [astPath]: data }));
      } catch (e) {
        setTreeCache((s) => ({ ...s, [astPath]: { error: e.message } }));
      }
    },
    [project, openFiles, treeCache],
  );

  const byLang = summary?.byLanguage || {};

  return (
    <section className="card scip-viewer">
      <header className="calls-head">
        <h2>语法树查看器</h2>
        <select
          className="scip-project"
          value={project}
          onChange={(e) => loadSummary(e.target.value)}
        >
          <option value="">选择项目…</option>
          {projectNames.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </header>

      {error && <p className="scip-error">{error}</p>}
      {loading && <p className="muted">加载语法树文件列表…</p>}

      {summary && (
        <div className="scip-meta">
          <span>
            语法树文件: <b>{summary.files.length}</b>
          </span>
          <span>
            有 index: <b>{summary.indexedFiles}</b>
          </span>
          <span>
            解析错误: <b>{summary.totalErrors}</b>
          </span>
          <span className="scip-meta-args">
            按语言:{" "}
            {Object.entries(byLang)
              .map(([l, n]) => `${l}(${n})`)
              .join("  ")}
          </span>
          {summary.astRoot && <span className="muted">{summary.astRoot}</span>}
        </div>
      )}

      {summary && (
        <ul className="scip-doc-list">
          {summary.files.map((f) => {
            const open = !!openFiles[f.astPath];
            const cached = treeCache[f.astPath];
            return (
              <li key={f.astPath}>
                <button
                  className={`scip-doc-toggle ${open ? "open" : ""} ${f.hasIndex ? "" : "has-no-index"}`}
                  onClick={() => toggleFile(f.astPath)}
                >
                  <span className="caret">{open ? "▾" : "▸"}</span>
                  <code className="scip-doc-path">{f.astPath}</code>
                  <span className="scip-doc-lang">{f.language}</span>
                  {f.hasIndex ? (
                    <span className="scip-no-coord-tag">有 index</span>
                  ) : (
                    <span className="no-index-tag">无 index</span>
                  )}
                  {f.errorCount > 0 && <span className="ast-errors">{f.errorCount} err</span>}
                </button>
                {open && (
                  <div className="scip-doc-body">
                    {cached === undefined ? (
                      <span className="muted">加载中…</span>
                    ) : cached?.error ? (
                      <span className="scip-error">{cached.error}</span>
                    ) : (
                      <AstTreeView
                        ast={cached.ast}
                        source={cached.source}
                        occurrences={cached.occurrences}
                      />
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!project && !error && (
        <p className="muted">选择一个挂载项目查看 tree-sitter 生成的语法树。</p>
      )}
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
              MCP 端点 / · {health.tools.length} 工具
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
          <ScipIndexViewer projects={projects} />
          <AstViewer projects={projects} />

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
