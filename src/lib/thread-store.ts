import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

export type JobStatus = "started" | "in_progress" | "completed" | "failed";

export interface ThreadState {
  jobId: string;
  channel: string;
  threadTs: string;
  title: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  permalink?: string;
}

interface DebounceEntry {
  message: string;
  level: "info" | "warn" | "debug";
  timeout: NodeJS.Timeout;
}

export class ThreadStore {
  private threads: Map<string, ThreadState> = new Map();
  private persistPath?: string;
  private debounceMs: number;
  private pendingUpdates: Map<string, DebounceEntry> = new Map();

  constructor(persistPath?: string, debounceMs: number = 2000) {
    this.persistPath = persistPath;
    this.debounceMs = debounceMs;

    if (persistPath) {
      this.loadFromDisk();
    }
  }

  private loadFromDisk(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) {
      return;
    }

    try {
      const data = readFileSync(this.persistPath, "utf-8");
      const parsed = JSON.parse(data) as ThreadState[];
      for (const state of parsed) {
        this.threads.set(state.jobId, state);
      }
    } catch {
      // If file is corrupted, start fresh
    }
  }

  private saveToDisk(): void {
    if (!this.persistPath) {
      return;
    }

    try {
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const data = JSON.stringify(Array.from(this.threads.values()), null, 2);
      writeFileSync(this.persistPath, data, "utf-8");
    } catch {
      // Best effort persistence
    }
  }

  get(jobId: string): ThreadState | undefined {
    return this.threads.get(jobId);
  }

  has(jobId: string): boolean {
    return this.threads.has(jobId);
  }

  create(
    jobId: string,
    channel: string,
    threadTs: string,
    title: string,
    permalink?: string
  ): ThreadState {
    const now = new Date().toISOString();
    const state: ThreadState = {
      jobId,
      channel,
      threadTs,
      title,
      status: "started",
      createdAt: now,
      updatedAt: now,
      permalink,
    };

    this.threads.set(jobId, state);
    this.saveToDisk();

    return state;
  }

  updateStatus(jobId: string, status: JobStatus): boolean {
    const state = this.threads.get(jobId);
    if (!state) {
      return false;
    }

    state.status = status;
    state.updatedAt = new Date().toISOString();
    this.saveToDisk();

    return true;
  }

  isTerminal(jobId: string): boolean {
    const state = this.threads.get(jobId);
    if (!state) {
      return false;
    }
    return state.status === "completed" || state.status === "failed";
  }

  scheduleUpdate(
    jobId: string,
    message: string,
    level: "info" | "warn" | "debug",
    callback: (msg: string, lvl: "info" | "warn" | "debug") => Promise<void>
  ): void {
    const existing = this.pendingUpdates.get(jobId);

    if (existing) {
      clearTimeout(existing.timeout);
    }

    const timeout = setTimeout(async () => {
      this.pendingUpdates.delete(jobId);
      await callback(message, level);
    }, this.debounceMs);

    this.pendingUpdates.set(jobId, { message, level, timeout });
  }

  flushUpdate(jobId: string): DebounceEntry | undefined {
    const entry = this.pendingUpdates.get(jobId);
    if (entry) {
      clearTimeout(entry.timeout);
      this.pendingUpdates.delete(jobId);
    }
    return entry;
  }

  delete(jobId: string): boolean {
    const existed = this.threads.delete(jobId);
    if (existed) {
      this.saveToDisk();
    }
    return existed;
  }

  list(): ThreadState[] {
    return Array.from(this.threads.values());
  }
}
