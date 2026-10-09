/**
 * Mock of the slice of Companion 5.0.7's tRPC WebSocket API that companion-config.ts uses.
 * Behaviour follows the Companion source at v5.0.7 (see companion-config.ts header).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

interface Entity {
  id: string;
  type: 'action' | 'feedback';
  connectionId: string;
  definitionId: string;
  options: Record<string, unknown>;
}

interface Control {
  type: string;
  feedbacks: Entity[];
  steps: Record<
    string,
    { action_sets: Record<string, Entity[]>; options: Record<string, unknown> }
  >;
  options: Record<string, unknown>;
}

interface Page {
  id: string;
  name: string;
  controls: Record<string, Record<string, string>>;
}

export interface TrpcCall {
  readonly method: string;
  readonly path: string;
  readonly input: unknown;
}

export type TrpcMockMode = 'normal' | 'hang' | 'garbage' | 'error' | 'badshape' | 'closed';

export class MockTrpc {
  readonly calls: TrpcCall[] = [];
  readonly pages: Page[] = [];
  readonly controls = new Map<string, Control>();
  readonly knownConnections = new Set<string>(['conn1']);
  mode: TrpcMockMode = 'normal';
  #http: Server | undefined;
  #wss: WebSocketServer | undefined;
  #url: URL | undefined;
  #nextId = 1;

  get url(): URL {
    if (this.#url === undefined) {
      throw new Error('mock not started');
    }
    return this.#url;
  }

  reset(): void {
    this.calls.length = 0;
    this.pages.length = 0;
    this.controls.clear();
    this.mode = 'normal';
    this.#nextId = 1;
    this.pages.push({ id: 'p1', name: 'Page 1', controls: {} });
  }

  addButton(page: number, row: number, column: number): string {
    const id = `ctl${String(this.#nextId++)}`;
    const p = this.pages[page - 1];
    if (p === undefined) {
      throw new Error('no page');
    }
    const rowMap = p.controls[String(row)] ?? {};
    rowMap[String(column)] = id;
    p.controls[String(row)] = rowMap;
    this.controls.set(id, {
      type: 'button-layered',
      feedbacks: [],
      steps: { '0': { action_sets: { down: [], up: [] }, options: {} } },
      options: { stepProgression: 'auto', rotaryActions: false, canModifyStyleInApis: true },
    });
    return id;
  }

  async start(): Promise<void> {
    this.reset();
    this.#http = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    this.#wss = new WebSocketServer({ server: this.#http, path: '/trpc' });
    this.#wss.on('connection', (ws) => {
      this.#serve(ws);
    });
    await new Promise<void>((resolve) => {
      this.#http?.listen(0, '127.0.0.1', resolve);
    });
    const addr = this.#http.address() as AddressInfo;
    this.#url = new URL(`http://127.0.0.1:${String(addr.port)}`);
  }

  async stop(): Promise<void> {
    this.#wss?.clients.forEach((c) => {
      c.terminate();
    });
    await new Promise<void>((resolve) => {
      this.#wss?.close(() => {
        resolve();
      });
    });
    this.#http?.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.#http?.close(() => {
        resolve();
      });
    });
  }

  #serve(ws: WebSocket): void {
    if (this.mode === 'closed') {
      ws.close();
      return;
    }
    ws.on('message', (raw) => {
      const text = Buffer.isBuffer(raw)
        ? raw.toString('utf8')
        : Buffer.concat(raw as Buffer[]).toString('utf8');
      const msg = JSON.parse(text) as {
        id: number;
        method: string;
        params?: { path: string; input?: unknown };
      };
      if (msg.method === 'subscription.stop') {
        return;
      }
      const path = msg.params?.path ?? '';
      const input = msg.params?.input;
      this.calls.push({ method: msg.method, path, input });
      if (this.mode === 'hang') {
        return;
      }
      if (this.mode === 'garbage') {
        ws.send('{nope');
        return;
      }
      if (this.mode === 'error') {
        ws.send(JSON.stringify({ id: msg.id, error: { message: 'boom', code: -32603 } }));
        return;
      }
      const reply = (data: unknown): void => {
        if (msg.method === 'subscription') {
          ws.send(JSON.stringify({ id: msg.id, result: { type: 'started' } }));
        }
        ws.send(JSON.stringify({ id: msg.id, result: { type: 'data', data } }));
      };
      if (this.mode === 'badshape') {
        reply({ type: 'init', surprise: true });
        return;
      }
      reply(this.#route(path, input));
    });
  }

  #locate(loc: { pageNumber: number; row: number; column: number }): {
    page: Page | undefined;
    id: string | undefined;
  } {
    const page = this.pages[loc.pageNumber - 1];
    const id = page?.controls[String(loc.row)]?.[String(loc.column)];
    return { page, id };
  }

  #entityList(control: Control, where: unknown): Entity[] | undefined {
    if (where === 'feedbacks') {
      return control.feedbacks;
    }
    if (typeof where === 'object' && where !== null) {
      const w = where as { stepId: string; setId: string };
      const step = control.steps[w.stepId];
      if (step === undefined) {
        return undefined;
      }
      step.action_sets[w.setId] ??= [];
      return step.action_sets[w.setId];
    }
    return undefined;
  }

  #route(path: string, input: unknown): unknown {
    const i = input as Record<string, unknown>;
    switch (path) {
      case 'pages.watch':
        return {
          type: 'init',
          order: this.pages.map((p) => p.id),
          pages: Object.fromEntries(
            this.pages.map((p) => [p.id, { name: p.name, controls: p.controls }]),
          ),
        };
      case 'controls.watchControl': {
        const c = this.controls.get(String(i.controlId));
        if (c === undefined) {
          throw new Error('Control not found');
        }
        return { type: 'init', config: c, runtime: {} };
      }
      case 'controls.resetControl': {
        const loc = i.location as { pageNumber: number; row: number; column: number };
        const { page, id } = this.#locate(loc);
        if (page === undefined) {
          return undefined;
        }
        if (id !== undefined) {
          this.controls.delete(id);
          delete page.controls[String(loc.row)]?.[String(loc.column)];
        }
        if (i.newType === 'button-layered') {
          this.addButton(loc.pageNumber, loc.row, loc.column);
        }
        return undefined;
      }
      case 'pages.insert': {
        const names = i.pageNames as string[];
        const at = Number(i.asPageNumber);
        const fresh = names.map((name) => ({
          id: `p${String(this.#nextId++)}`,
          name,
          controls: {},
        }));
        this.pages.splice(at - 1, 0, ...fresh);
        return 'ok';
      }
      case 'controls.entities.add': {
        const c = this.controls.get(String(i.controlId));
        if (c === undefined || !this.knownConnections.has(String(i.connectionId))) {
          return null;
        }
        const list = this.#entityList(c, i.entityLocation);
        if (list === undefined) {
          return null;
        }
        const e: Entity = {
          id: `ent${String(this.#nextId++)}`,
          type: i.entityType as 'action' | 'feedback',
          connectionId: String(i.connectionId),
          definitionId: String(i.entityDefinition),
          options: {},
        };
        list.push(e);
        return e.id;
      }
      case 'controls.entities.setOption': {
        const c = this.controls.get(String(i.controlId));
        const list = c === undefined ? undefined : this.#entityList(c, i.entityLocation);
        const e = list?.find((x) => x.id === i.entityId);
        if (e === undefined) {
          return false;
        }
        e.options[String(i.key)] = i.value;
        return true;
      }
      case 'controls.entities.remove': {
        const c = this.controls.get(String(i.controlId));
        const list = c === undefined ? undefined : this.#entityList(c, i.entityLocation);
        if (list === undefined) {
          return false;
        }
        const idx = list.findIndex((x) => x.id === i.entityId);
        if (idx < 0) {
          return false;
        }
        list.splice(idx, 1);
        return true;
      }
      default:
        throw new Error(`unknown path ${path}`);
    }
  }
}
