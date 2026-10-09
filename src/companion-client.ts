import type { ReadableStreamReadResult } from 'node:stream/web';
import { z } from 'zod';
import { WriteAuthorisation, type ButtonLocation } from './authorisation.js';

export type { ButtonLocation } from './authorisation.js';

export type CompanionErrorKind = 'timeout' | 'network' | 'http' | 'malformed';

export class CompanionError extends Error {
  override readonly name = 'CompanionError';
  readonly kind: CompanionErrorKind;
  readonly status: number | undefined;
  /** True when a write may have reached Companion, so the real outcome is unknown. */
  readonly writeAttempted: boolean;

  constructor(
    kind: CompanionErrorKind,
    message: string,
    opts: { readonly status?: number; readonly writeAttempted?: boolean } = {},
  ) {
    super(message);
    this.kind = kind;
    this.status = opts.status;
    this.writeAttempted = opts.writeAttempted ?? false;
  }
}

export type VariableValue = string | number | boolean | null | VariableJson;
type VariableJson = Record<string, unknown> | unknown[];

export type VariableResult =
  { readonly found: true; readonly value: VariableValue } | { readonly found: false };

export type PressResult = 'ok' | 'no_control';
export type SetVariableResult = 'ok' | 'not_found';

const connectionStatusSchema = z.object({
  category: z.string().max(64).nullable().optional(),
  level: z.string().max(64).nullable().optional(),
  message: z.string().max(500).nullable().optional(),
});

const connectionSchema = z.object({
  id: z.string().max(128),
  label: z.string().max(128),
  moduleId: z.string().max(128).optional(),
  enabled: z.boolean(),
  sortOrder: z.number().optional(),
  status: connectionStatusSchema.nullable().optional(),
});

export type Connection = z.infer<typeof connectionSchema>;

export type ConnectionStatusResult =
  { readonly found: true; readonly connection: Connection } | { readonly found: false };

export const VARIABLE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const CONNECTION_LABEL_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const CONNECTION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const PAGE_MIN = 1;
export const PAGE_MAX = 99;
export const ROW_MIN = 0;
export const ROW_MAX = 31;
export const COLUMN_MIN = 0;
export const COLUMN_MAX = 31;
export const MAX_RESPONSE_BYTES = 256 * 1024;
export const MAX_CONNECTIONS = 500;

type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

interface RawResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

function assertInt(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new CompanionError(
      'malformed',
      `${label} must be an integer between ${String(min)} and ${String(max)}`,
    );
  }
  return value;
}

function assertPattern(value: string, re: RegExp, label: string): string {
  if (!re.test(value)) {
    throw new CompanionError('malformed', `${label} contains invalid characters or is too long`);
  }
  return value;
}

async function readBounded(res: Response): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_RESPONSE_BYTES) {
    throw new CompanionError('malformed', 'response too large');
  }
  if (res.body === null) {
    return '';
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk: ReadableStreamReadResult<Uint8Array> = await reader.read();
    if (chunk.done) {
      break;
    }
    const value = chunk.value;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new CompanionError('malformed', 'response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new CompanionError('malformed', 'Companion returned malformed JSON');
  }
}

function isTextNotFound(res: RawResponse): boolean {
  return res.status === 404 && res.body.trim() === 'Not found';
}

function isJsonNotFound(res: RawResponse): boolean {
  if (res.status !== 404) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(res.body);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { status?: unknown }).status === 404
    );
  } catch {
    return false;
  }
}

function unexpected(res: RawResponse, writeAttempted = false): CompanionError {
  if (res.status === 403) {
    return new CompanionError('http', 'Companion HTTP API is disabled (403)', { status: 403 });
  }
  return new CompanionError('http', `unexpected Companion response ${String(res.status)}`, {
    status: res.status,
    writeAttempted: writeAttempted && res.status >= 500,
  });
}

export class CompanionClient {
  readonly #baseUrl: URL;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;

  constructor(baseUrl: URL, timeoutMs: number, fetchImpl?: FetchLike) {
    this.#baseUrl = baseUrl;
    this.#timeoutMs = timeoutMs;
    this.#fetch = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  #url(segments: readonly string[]): URL {
    const url = new URL(this.#baseUrl);
    url.pathname = '/api/' + segments.map(encodeURIComponent).join('/');
    return url;
  }

  async #request(
    method: 'GET' | 'POST',
    segments: readonly string[],
    body?: { readonly contentType: string; readonly text: string },
  ): Promise<RawResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);
    const init: RequestInit = { method, signal: controller.signal, redirect: 'error' };
    if (body !== undefined) {
      init.headers = { 'content-type': body.contentType };
      init.body = body.text;
    }
    const writeAttempted = method === 'POST';
    try {
      const res = await this.#fetch(this.#url(segments), init);
      const text = await readBounded(res);
      return {
        status: res.status,
        contentType: res.headers.get('content-type') ?? '',
        body: text,
      };
    } catch (err) {
      if (err instanceof CompanionError) {
        throw new CompanionError(err.kind, err.message, { writeAttempted });
      }
      if (controller.signal.aborted) {
        throw new CompanionError(
          'timeout',
          `Companion did not respond within ${String(this.#timeoutMs)}ms`,
          { writeAttempted },
        );
      }
      throw new CompanionError('network', 'could not reach Companion', { writeAttempted });
    } finally {
      clearTimeout(timer);
    }
  }

  #parseVariable(res: RawResponse): VariableResult {
    if (isTextNotFound(res)) {
      return { found: false };
    }
    if (res.status !== 200) {
      throw unexpected(res);
    }
    if (res.contentType.toLowerCase().includes('application/json')) {
      return { found: true, value: parseJson(res.body) as VariableValue };
    }
    return { found: true, value: res.body };
  }

  async getCustomVariable(name: string): Promise<VariableResult> {
    const safeName = assertPattern(name, VARIABLE_NAME_RE, 'variable name');
    return this.#parseVariable(await this.#request('GET', ['custom-variable', safeName, 'value']));
  }

  async getModuleVariable(label: string, name: string): Promise<VariableResult> {
    const safeLabel = assertPattern(label, CONNECTION_LABEL_RE, 'connection label');
    const safeName = assertPattern(name, VARIABLE_NAME_RE, 'variable name');
    return this.#parseVariable(
      await this.#request('GET', ['variable', safeLabel, safeName, 'value']),
    );
  }

  async listConnections(): Promise<Connection[]> {
    const res = await this.#request('GET', ['connections']);
    if (res.status !== 200) {
      throw unexpected(res);
    }
    const result = z.array(connectionSchema).max(MAX_CONNECTIONS).safeParse(parseJson(res.body));
    if (!result.success) {
      throw new CompanionError('malformed', 'Companion connection list had an unexpected shape');
    }
    return result.data;
  }

  async getConnectionStatus(id: string): Promise<ConnectionStatusResult> {
    const safeId = assertPattern(id, CONNECTION_ID_RE, 'connection id');
    const res = await this.#request('GET', ['connections', safeId, 'status']);
    if (isJsonNotFound(res)) {
      return { found: false };
    }
    if (res.status !== 200) {
      throw unexpected(res);
    }
    const result = connectionSchema.safeParse(parseJson(res.body));
    if (!result.success) {
      throw new CompanionError('malformed', 'Companion connection status had an unexpected shape');
    }
    return { found: true, connection: result.data };
  }

  async pressButton(location: ButtonLocation, auth: WriteAuthorisation): Promise<PressResult> {
    if (!(auth instanceof WriteAuthorisation) || !auth.coversButton(location)) {
      throw new CompanionError('malformed', 'press not authorised by the safety layer');
    }
    const page = assertInt(location.page, PAGE_MIN, PAGE_MAX, 'page');
    const row = assertInt(location.row, ROW_MIN, ROW_MAX, 'row');
    const column = assertInt(location.column, COLUMN_MIN, COLUMN_MAX, 'column');
    const res = await this.#request('POST', [
      'location',
      String(page),
      String(row),
      String(column),
      'press',
    ]);
    if (res.status === 204) {
      return 'no_control';
    }
    if (res.status === 200) {
      return 'ok';
    }
    throw unexpected(res, true);
  }

  async setCustomVariable(
    name: string,
    value: string,
    auth: WriteAuthorisation,
  ): Promise<SetVariableResult> {
    if (!(auth instanceof WriteAuthorisation) || !auth.coversVariable(name)) {
      throw new CompanionError('malformed', 'write not authorised by the safety layer');
    }
    const safeName = assertPattern(name, VARIABLE_NAME_RE, 'variable name');
    if (value.trim() === '') {
      throw new CompanionError('malformed', 'value must not be empty');
    }
    const res = await this.#request('POST', ['custom-variable', safeName, 'value'], {
      contentType: 'text/plain',
      text: value,
    });
    if (isTextNotFound(res)) {
      return 'not_found';
    }
    if (res.status === 400) {
      throw new CompanionError('http', 'Companion rejected the value (400 No value)', {
        status: 400,
      });
    }
    if (res.status === 200) {
      return 'ok';
    }
    throw unexpected(res, true);
  }
}
