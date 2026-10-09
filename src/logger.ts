import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

export const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_STRING = 200;
const MAX_DEPTH = 4;
const MAX_KEYS = 50;
const SECRET_KEY_RE = /(token|secret|password|passwd|key|auth|credential|cookie)/i;

export interface LogEntry {
  readonly tool: string;
  readonly args: unknown;
  readonly outcome: 'ok' | 'error' | 'refused';
  readonly allowed: boolean;
  readonly dryRun?: boolean;
  readonly detail?: string;
  readonly durationMs?: number;
}

export interface Logger {
  log(entry: LogEntry): void;
}

export function sanitise(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) {
    return '[truncated]';
  }
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '...' : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  if (value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_KEYS).map((v) => sanitise(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value).slice(0, MAX_KEYS)) {
      out[k] = SECRET_KEY_RE.test(k) ? '[redacted]' : sanitise(v, depth + 1);
    }
    return out;
  }
  return typeof value;
}

export class JsonlLogger implements Logger {
  readonly #file: string;

  constructor(dir: string, fileName = 'companion-mcp.jsonl') {
    mkdirSync(dir, { recursive: true });
    this.#file = path.join(dir, fileName);
  }

  #rotateIfNeeded(): void {
    let size = 0;
    try {
      size = statSync(this.#file).size;
    } catch {
      return;
    }
    if (size >= MAX_LOG_BYTES) {
      renameSync(this.#file, this.#file + '.1');
    }
  }

  log(entry: LogEntry): void {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...entry,
      args: sanitise(entry.args),
    });
    try {
      this.#rotateIfNeeded();
      appendFileSync(this.#file, line + '\n', { encoding: 'utf8' });
    } catch {
      process.stderr.write('companion-mcp: failed to write log\n');
    }
  }
}

export class MemoryLogger implements Logger {
  readonly entries: LogEntry[] = [];

  log(entry: LogEntry): void {
    this.entries.push({ ...entry, args: sanitise(entry.args) });
  }
}
