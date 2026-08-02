import { Injectable } from "@nestjs/common";
import * as path from "node:path";
import { ToolExecutorService } from "./tool-executor.service";
import { CodeReaderService, ReadFileResult } from "./code-reader.service";
import { CodeDisplayService } from "./code-display.service";

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  py: "Python",
  cpp: "C++",
  cc: "C++",
  cxx: "C++",
  h: "C++",
  hpp: "C++",
  go: "Go",
  rs: "Rust",
  java: "Java",
  rb: "Ruby",
  php: "PHP",
  sh: "Shell",
  bash: "Shell",
  sql: "SQL",
  json: "JSON",
  yml: "YAML",
  yaml: "YAML",
  toml: "TOML",
  md: "Markdown",
  html: "HTML",
  css: "CSS",
  vue: "Vue",
  svelte: "Svelte",
};

function inferLanguage(relPath: string): string {
  const ext = path.extname(relPath).slice(1).toLowerCase();
  return LANGUAGE_BY_EXT[ext] || ext || "Text";
}

/**
 * YOUR BUSINESS LOGIC LIVES HERE.
 *
 * These are the methods the MCP tools call (through thin wrappers in
 * src/tools/*.tool.ts) and the web pages call (through src/api/api.controller.ts).
 */
@Injectable()
export class ToolService {
  constructor(
    private readonly executor: ToolExecutorService,
    private readonly codeReader: CodeReaderService,
    private readonly display: CodeDisplayService,
  ) {}

  /**
   * 从项目根目录读取一个文件的完整内容（不分页），同时把它推给
   * 8081 功能页展示 —— read_file 一个工具同时完成"AI 读"和"人看"。
   */
  readFile(input: { path: string; filename?: string; language?: string }): ReadFileResult {
    const file = this.codeReader.readFile(input.path);
    this.display.set({
      filename: input.filename || path.basename(file.path),
      language: input.language || inferLanguage(file.path),
      code: file.content,
    });
    return file;
  }

  /** 当前 8081 功能页要展示的文件（没有则为 null）。 */
  getDisplayedFile() {
    return this.display.get();
  }
}
