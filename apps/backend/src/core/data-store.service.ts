import { Injectable } from "@nestjs/common";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Persistent store for project-generated data.
 *
 * The container gets a dedicated writable mount at DATA_ROOT (default /data),
 * backed by a host directory (HOST_DATA_ROOT). Code mounts are read-only; this
 * is the one place the app may write to, so anything saved here survives
 * container rebuilds. AI can read the files back through read_file using the
 * host absolute path (HOST_DATA_ROOT/...), same mapping as code projects.
 *
 * Writes are best-effort: if DATA_ROOT is not writable (e.g. local `npm run
 * dev` without the mount), the app simply keeps working without persistence.
 */
@Injectable()
export class DataStoreService {
  private readonly root: string;
  private readonly hostRoot: string | null;
  private readonly writable: boolean;

  constructor() {
    this.root = path.resolve(process.env.DATA_ROOT || "/data");
    this.hostRoot = process.env.HOST_DATA_ROOT
      ? path.resolve(process.env.HOST_DATA_ROOT)
      : null;
    this.writable = this.probeWritable();
  }

  getRoot(): string {
    return this.root;
  }

  getHostRoot(): string | null {
    return this.hostRoot;
  }

  isWritable(): boolean {
    return this.writable;
  }

  /** Append one JSON line to <root>/logs/<file>. */
  appendJson(file: string, entry: unknown): void {
    if (!this.writable) return;
    try {
      const dir = path.join(this.root, "logs");
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, file), JSON.stringify(entry) + "\n");
    } catch {
      /* best-effort: a failed write must not break the request */
    }
  }

  /** All JSON lines persisted so far, across every logs/*.jsonl (oldest first). */
  readLogLines(): string[] {
    if (!this.writable) return [];
    try {
      const dir = path.join(this.root, "logs");
      if (!fs.existsSync(dir)) return [];
      const lines: string[] = [];
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".jsonl")).sort()) {
        for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
          if (line.trim()) lines.push(line);
        }
      }
      return lines;
    } catch {
      return [];
    }
  }

  private probeWritable(): boolean {
    try {
      fs.mkdirSync(this.root, { recursive: true });
      const probe = path.join(this.root, `.write-probe-${process.pid}`);
      fs.writeFileSync(probe, "");
      fs.unlinkSync(probe);
      return true;
    } catch {
      return false;
    }
  }
}
