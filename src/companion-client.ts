import { z } from 'zod';

export type CompanionErrorKind = 'timeout' | 'network' | 'http' | 'malformed';

export class CompanionError extends Error {
  override readonly name = 'CompanionError';
  readonly kind: CompanionErrorKind;
  readonly status: number | undefined;

  constructor(kind: CompanionErrorKind, message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export interface ButtonLocation {
  readonly page: number;
  readonly row: number;
  readonly column: number;
}

export type VariableValue = string | number | boolean | null | VariableJson;
type VariableJson = Record<string, unknown> | unknown[];

export type VariableResult =
  { readonly found: true; readonly value: VariableValue } | { readonly found: false };

export type PressResult = 'ok' | 'no_control';
export type SetVariableResult = 'ok' | 'not_found';

const connectionStatusSchema = z.looseObject({
  category: z.string().nullable().optional(),
  level: z.string().nullable().optional(),
  message: z.string().nullable().optional(),
});

const connectionSchema = z.looseObject({
  id: z.string(),
  label: z.string(),
  moduleId: z.string().optional(),
  enabled: z.boolean(),
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
    try {
      const res = await this.#fetch(this.#url(segments), init);
      const text = await res.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        throw new CompanionError('malformed', 'response too large');
      }
      return {
        status: res.status,
        contentType: res.headers.get('content-type') ?? '',
        body: text,
      };
    } catch (err) {
      if (err instanceof CompanionError) {
        throw err;
      }
      if (controller.signal.aborted) {
        throw new CompanionError(
          'timeout',
          `Companion did not respond within ${String(this.#timeoutMs)}ms`,
        );
      }
      throw new CompanionError('network', 'could not reach Companion');
    } finally {
      clearTimeout(timer);
    }
  }

  #unexpected(res: RawResponse): CompanionError {
    if (res.status === 403) {
      return new CompanionError('http', 'Companion HTTP API is disabled (403)', 403);
    }
    return new CompanionError(
      'http',
      `unexpected Companion response ${String(res.status)}`,
      res.status,
    );
  }

  #parseVariable(res: RawResponse): VariableResult {
    if (res.status === 404) {
      return { found: false };
    }
    if (res.status !== 200) {
      throw this.#unexpected(res);
    }
    if (res.contentType.toLowerCase().includes('application/json')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(res.body);
      } catch {
        throw new CompanionError('malformed', 'Companion returned malformed JSON');
      }
      return { found: true, value: parsed as VariableValue };
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
      throw this.#unexpected(res);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw new CompanionError('malformed', 'Companion returned malformed JSON');
    }
    const result = z.array(connectionSchema).safeParse(parsed);
    if (!result.success) {
      throw new CompanionError('malformed', 'Companion connection list had an unexpected shape');
    }
    return result.data;
  }

  async getConnectionStatus(id: string): Promise<ConnectionStatusResult> {
    const safeId = assertPattern(id, CONNECTION_ID_RE, 'connection id');
    const res = await this.#request('GET', ['connections', safeId, 'status']);
    if (res.status === 404) {
      return { found: false };
    }
    if (res.status !== 200) {
      throw this.#unexpected(res);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw new CompanionError('malformed', 'Companion returned malformed JSON');
    }
    const result = connectionSchema.safeParse(parsed);
    if (!result.success) {
      throw new CompanionError('malformed', 'Companion connection status had an unexpected shape');
    }
    return { found: true, connection: result.data };
  }

  async pressButton(location: ButtonLocation): Promise<PressResult> {
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
    throw this.#unexpected(res);
  }

  async setCustomVariable(name: string, value: string): Promise<SetVariableResult> {
    const safeName = assertPattern(name, VARIABLE_NAME_RE, 'variable name');
    const res = await this.#request('POST', ['custom-variable', safeName, 'value'], {
      contentType: 'text/plain',
      text: value,
    });
    if (res.status === 404) {
      return 'not_found';
    }
    if (res.status === 200) {
      return 'ok';
    }
    throw this.#unexpected(res);
  }
}
