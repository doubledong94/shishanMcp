import { Injectable, Logger } from "@nestjs/common";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { NativePaths } from "./native-paths";

/**
 * THE place where Python / C++ subprocesses are launched.
 *
 * Protocol used by every executor here:
 *   - input  : JSON written to the child's STDIN
 *   - output : JSON read from the child's STDOUT
 *   - errors : child's STDERR + a non-zero exit code -> thrown Error
 *
 * This is intentionally a thin, reusable primitive. Your own tools call
 * `runPython("some_script.py", payload)` / `runCpp({ ... })` — you never
 * touch child_process yourself.
 */
@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger(ToolExecutorService.name);

  constructor(private readonly paths: NativePaths) {}

  /** Run one of your Python scripts (living in native/python/). */
  async runPython(script: string, payload: unknown): Promise<unknown> {
    const scriptPath = path.join(this.paths.pythonScriptDir, script);
    this.logger.log(`runPython: ${this.paths.pythonBinary} ${scriptPath}`);
    return this.runJsonChild(this.paths.pythonBinary, [scriptPath], payload);
  }

  /** Run the compiled C++ binary (from native/cpp/, built as "worker"). */
  async runCpp(payload: { n: number }): Promise<unknown> {
    this.logger.log(`runCpp: ${this.paths.cppBinary} ${payload.n}`);
    return this.runJsonChild(this.paths.cppBinary, [String(payload.n)], payload);
  }

  private runJsonChild(bin: string, args: string[], input: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", (err) => reject(new Error(`failed to spawn ${bin}: ${err.message}`)));

      child.on("close", (code) => {
        if (code !== 0) {
          return reject(
            new Error(`[${path.basename(bin)}] exited with code ${code}\nstderr: ${stderr}`),
          );
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error(`[${path.basename(bin)}] produced non-JSON output: ${stdout}`));
        }
      });

      child.stdin.end(JSON.stringify(input));
    });
  }
}
