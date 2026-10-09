#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CompanionClient } from './companion-client.js';
import { loadConfig } from './config.js';
import { JsonlLogger } from './logger.js';
import { loadAllowlist } from './safety.js';
import { createServer } from './server.js';

function fail(message: string): never {
  process.stderr.write(`companion-mcp: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  let config;
  let allowlist;
  try {
    config = loadConfig();
    allowlist = loadAllowlist(config.allowlistPath);
  } catch (err) {
    fail(err instanceof Error ? err.message : 'startup failed');
  }
  const logger = new JsonlLogger(config.logDir);
  const client = new CompanionClient(config.companionUrl, config.timeoutMs);
  const server = createServer({ config, client, logger, allowlist });
  process.stderr.write(
    `companion-mcp: started. writes ${config.allowWrites ? 'ENABLED' : 'disabled'}, companion ${config.companionUrl.host}, ${String(allowlist.buttons.length)} allowlisted buttons\n`,
  );
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : 'fatal error');
});
