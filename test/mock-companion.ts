import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SeenRequest {
  readonly method: string;
  readonly path: string;
  readonly contentType: string | undefined;
  readonly body: string;
}

export type MockMode = 'normal' | 'hang' | 'garbage' | 'disabled';

export class MockCompanion {
  readonly requests: SeenRequest[] = [];
  readonly customVariables = new Map<string, unknown>();
  readonly moduleVariables = new Map<string, unknown>();
  readonly buttons = new Set<string>();
  connections: unknown[] = [];
  mode: MockMode = 'normal';
  #server: Server | undefined;
  #url: URL | undefined;

  get url(): URL {
    if (this.#url === undefined) {
      throw new Error('mock not started');
    }
    return this.#url;
  }

  async start(): Promise<void> {
    this.#server = createServer((req, res) => {
      this.#handle(req, res);
    });
    await new Promise<void>((resolve) => {
      this.#server?.listen(0, '127.0.0.1', resolve);
    });
    const addr = this.#server.address() as AddressInfo;
    this.#url = new URL(`http://127.0.0.1:${String(addr.port)}`);
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (server === undefined) {
      return;
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }

  #handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const path = req.url ?? '';
      this.requests.push({
        method: req.method ?? '',
        path,
        contentType: req.headers['content-type'],
        body,
      });
      if (this.mode === 'hang') {
        return;
      }
      if (this.mode === 'disabled') {
        res.statusCode = 403;
        res.end();
        return;
      }
      if (this.mode === 'garbage') {
        res.setHeader('content-type', 'application/json');
        res.end('{not json');
        return;
      }
      this.#route(req.method ?? '', path, body, res);
    });
  }

  #send(res: ServerResponse, status: number, value: unknown): void {
    res.statusCode = status;
    if (typeof value === 'string') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(value);
    } else if (typeof value === 'number') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(String(value));
    } else {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(value));
    }
  }

  #route(method: string, path: string, body: string, res: ServerResponse): void {
    const url = new URL(path, 'http://x');
    const seg = url.pathname.split('/').filter((s) => s !== '');
    if (seg[0] !== 'api') {
      this.#send(res, 404, '');
      return;
    }
    if (method === 'POST' && seg[1] === 'location' && seg.length === 6 && seg[5] === 'press') {
      const key = `${seg[2] ?? ''}/${seg[3] ?? ''}/${seg[4] ?? ''}`;
      if (this.buttons.has(key)) {
        this.#send(res, 200, 'ok');
      } else {
        this.#send(res, 204, 'No control');
      }
      return;
    }
    if (seg[1] === 'custom-variable' && seg.length === 4 && seg[3] === 'value') {
      const name = seg[2] ?? '';
      if (method === 'GET') {
        if (!this.customVariables.has(name)) {
          this.#send(res, 404, 'Not found');
        } else {
          this.#send(res, 200, this.customVariables.get(name));
        }
        return;
      }
      if (method === 'POST') {
        if (!this.customVariables.has(name)) {
          this.#send(res, 404, 'Not found');
        } else {
          this.customVariables.set(name, body.trim());
          this.#send(res, 200, 'ok');
        }
        return;
      }
    }
    if (method === 'GET' && seg[1] === 'variable' && seg.length === 5 && seg[4] === 'value') {
      const key = `${seg[2] ?? ''}:${seg[3] ?? ''}`;
      if (!this.moduleVariables.has(key)) {
        this.#send(res, 404, 'Not found');
      } else {
        this.#send(res, 200, this.moduleVariables.get(key));
      }
      return;
    }
    if (method === 'GET' && seg[1] === 'connections' && seg.length === 2) {
      this.#send(res, 200, this.connections);
      return;
    }
    if (method === 'GET' && seg[1] === 'connections' && seg.length === 4 && seg[3] === 'status') {
      const found = this.connections.find(
        (c) => typeof c === 'object' && c !== null && (c as { id?: unknown }).id === seg[2],
      );
      if (found === undefined) {
        this.#send(res, 404, { status: 404, message: 'Connection not found' });
      } else {
        this.#send(res, 200, found);
      }
      return;
    }
    this.#send(res, 404, '');
  }
}
