#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CompanionClient } from './companion-client.js';
import { ConfigError, loadConfig } from './config.js';
import { JsonlLogger } from './logger.js';
import { AllowlistError, loadAllowlist } from './safety.js';
import { createServer } from './server.js';

function fail(message: string): never {
  process.stderr.write(`companion-mcp: ${message}\n`);
  process.exit(1);
}

function startupMessage(err: unknown): string {
  if (err instanceof ConfigError || err instanceof AllowlistError) {
    return err.message;
  }
  return 'startup failed (check COMPANION_LOG_DIR is writable)';
}

async function main(): Promise<void> {
  let config;
  let allowlist;
  let logger;
  try {
    config = loadConfig();
    allowlist = loadAllowlist(config.allowlistPath);
    logger = new JsonlLogger(config.logDir);
  } catch (err) {
    fail(startupMessage(err));
  }
  const client = new CompanionClient(config.companionUrl, config.timeoutMs);
  const server = createServer({ config, client, logger, allowlist });
  process.stderr.write(
    `companion-mcp: started. writes ${config.allowWrites ? 'ENABLED' : 'disabled'}, companion ${config.companionUrl.host}, ${String(allowlist.buttons.length)} allowlisted buttons\n`,
  );
  await server.connect(new StdioServerTransport());
}

main().catch(() => {
  fail('fatal error');
});
