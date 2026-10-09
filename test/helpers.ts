import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CompanionClient } from '../src/companion-client.js';
import type { Config } from '../src/config.js';
import { MemoryLogger } from '../src/logger.js';
import type { Allowlist } from '../src/safety.js';
import { createServer } from '../src/server.js';
import type { MockCompanion } from './mock-companion.js';

export const testAllowlist: Allowlist = {
  buttons: [
    { page: 1, row: 0, column: 0, label: 'Cam 1', risk: 'low' },
    { page: 1, row: 3, column: 7, label: 'STREAM STOP', risk: 'high' },
  ],
  variables: ['cue'],
};

export function makeConfig(url: URL, overrides: Partial<Config> = {}): Config {
  return {
    companionUrl: url,
    allowWrites: false,
    allowRemote: false,
    allowlistPath: '/tmp/allowlist.json',
    timeoutMs: 300,
    logDir: '/tmp/logs',
    ...overrides,
  };
}

export interface Harness {
  readonly client: Client;
  readonly logger: MemoryLogger;
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

export async function startHarness(
  mock: MockCompanion,
  opts: { allowWrites?: boolean; allowlist?: Allowlist; timeoutMs?: number } = {},
): Promise<Harness> {
  const config = makeConfig(mock.url, {
    allowWrites: opts.allowWrites ?? false,
    timeoutMs: opts.timeoutMs ?? 300,
  });
  const logger = new MemoryLogger();
  const companion = new CompanionClient(config.companionUrl, config.timeoutMs);
  const server = createServer({
    config,
    client: companion,
    logger,
    allowlist: opts.allowlist ?? testAllowlist,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    logger,
    call: (name, args = {}) =>
      client.callTool({ name, arguments: args }) as Promise<CallToolResult>,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first?.type === 'text' ? first.text : '';
}
