import { Injectable } from "@nestjs/common";

export interface DisplayedFile {
  filename: string;
  language: string;
  code: string;
  updatedAt: string;
}

/**
 * Holds the last file the AI's `read_file` tool read, so the web page
 * (:8081) can show exactly what the AI is looking at. In-memory only —
 * it resets when the backend restarts (accepted trade-off for now).
 */
@Injectable()
export class CodeDisplayService {
  private file: DisplayedFile | null = null;

  set(file: Omit<DisplayedFile, "updatedAt">): DisplayedFile {
    this.file = { ...file, updatedAt: new Date().toISOString() };
    return this.file;
  }

  get(): DisplayedFile | null {
    return this.file;
  }
}
