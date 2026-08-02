import { Injectable } from "@nestjs/common";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Resolves the on-disk locations of the Python interpreter / C++ binary.
 *
 * The same code runs in two places:
 *   - locally (dev): `npm run dev` from apps/backend, native stuff is one
 *     level up at <repo>/native
 *   - in Docker: everything is under /app (backend at /app/backend,
 *     native at /app/native, venv python at /opt/venv/bin/python3)
 *
 * Every value can be overridden with an env var — that is the escape hatch
 * for your own deployment layout.
 */
@Injectable()
export class NativePaths {
  readonly nativeDir: string;
  readonly pythonScriptDir: string;
  readonly pythonBinary: string;
  readonly cppBinary: string;

  constructor() {
    const cwd = process.cwd();

    this.nativeDir = this.firstExisting([
      process.env.SHISHAN_NATIVE_DIR,
      "/app/native",
      path.resolve(cwd, "native"),
      path.resolve(cwd, "../../native"),
    ]) as string;

    this.pythonScriptDir = path.join(this.nativeDir, "python");

    // A bare command (e.g. "python3") is resolved via PATH at spawn time, so
    // it is a valid fallback even though fs.accessSync cannot see it.
    this.pythonBinary =
      this.firstExisting([process.env.SHISHAN_PYTHON, "/opt/venv/bin/python3"]) ?? "python3";

    this.cppBinary =
      this.firstExisting([
        process.env.SHISHAN_CPP_BIN,
        "/opt/bin/worker",
        path.join(this.nativeDir, "cpp/build/worker"),
      ]) ?? "worker";
  }

  private firstExisting(candidates: Array<string | undefined>): string | undefined {
    for (const c of candidates) {
      if (!c) continue;
      try {
        fs.accessSync(c);
        return c;
      } catch {
        /* try next */
      }
    }
    return undefined;
  }
}
