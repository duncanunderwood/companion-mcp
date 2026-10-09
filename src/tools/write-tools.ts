import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { guard, type ToolOutcome } from '../guard.js';
import { evaluatePress, evaluateSetVariable, locationKey, WriteLimiter } from '../safety.js';
import {
  columnSchema,
  confirmSchema,
  dryRunSchema,
  pageSchema,
  rowSchema,
  variableNameSchema,
  variableValueSchema,
} from './schemas.js';

const LOGGER_UNHEALTHY = 'audit log is not writable, writes are refused until it is';

export function registerWriteTools(
  server: McpServer,
  ctx: AppContext,
  limiter: WriteLimiter = new WriteLimiter(),
): void {
  const safety = { allowWrites: ctx.config.allowWrites, allowlist: ctx.allowlist };

  function refused(summary: string, data: Record<string, unknown>, dryRun: boolean): ToolOutcome {
    return {
      summary: `REFUSED: ${summary}`,
      data: { ...data, refused: true },
      refused: true,
      dryRun,
    };
  }

  server.registerTool(
    'press_button',
    {
      title: 'Press button',
      description:
        'Press and release a Companion button at page/row/column. ONLY buttons on the allowlist (see list_allowlist) can be pressed; anything else is refused. Defaults to dry_run: true which reports what would be sent without sending it. To actually press, pass dry_run: false. High risk buttons also need confirm: true. One attempt only, never retried, and the same button cannot be pressed again for 2 seconds. A result of "ok" means Companion accepted the press, not that the downstream device acted; verify by reading a variable back. On timeout or network error the outcome is unknown.',
      inputSchema: z
        .object({
          page: pageSchema,
          row: rowSchema,
          column: columnSchema,
          dry_run: dryRunSchema,
          confirm: confirmSchema,
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    guard(
      ctx.logger,
      'press_button',
      async ({ page, row, column, dry_run, confirm }): Promise<ToolOutcome> => {
        const loc = { page, row, column };
        const key = locationKey(loc);
        const decision = evaluatePress(safety, loc, { confirm });
        if (!decision.allowed) {
          return refused(decision.reason, { location: loc, reason: decision.reason }, dry_run);
        }
        const entry = decision.entry;
        if (dry_run) {
          return {
            summary: `DRY RUN: would POST /api/location/${key}/press for "${entry.label}" (risk ${entry.risk}). Nothing sent.`,
            data: {
              location: loc,
              label: entry.label,
              risk: entry.risk,
              dryRun: true,
              sent: false,
            },
            dryRun: true,
          };
        }
        const slot = limiter.acquire(`button ${key}`);
        if (!slot.ok) {
          return refused(slot.reason, { location: loc, reason: slot.reason }, false);
        }
        try {
          const intent = ctx.logger.log({
            tool: 'press_button',
            args: { page, row, column, confirm },
            outcome: 'attempt',
            allowed: true,
            dryRun: false,
            detail: `about to press "${entry.label}" at ${key}`,
          });
          if (!intent) {
            return refused(LOGGER_UNHEALTHY, { location: loc, reason: LOGGER_UNHEALTHY }, false);
          }
          const result = await ctx.client.pressButton(loc, decision.auth);
          const data = { location: loc, label: entry.label, dryRun: false, sent: true, result };
          if (result === 'no_control') {
            return {
              summary: `Companion reports no button at ${key} ("${entry.label}" in allowlist). Allowlist may be stale.`,
              data,
              dryRun: false,
            };
          }
          return {
            summary: `pressed "${entry.label}" at ${key}. Companion accepted the press.`,
            data,
            dryRun: false,
          };
        } finally {
          slot.release();
        }
      },
    ),
  );

  server.registerTool(
    'set_custom_variable',
    {
      title: 'Set custom variable',
      description:
        'Set a Companion custom variable to a non-empty text value. ONLY variable names on the allowlist (see list_allowlist) can be set. Defaults to dry_run: true which reports what would be sent without sending it. Pass dry_run: false to actually write. One attempt only, never retried, and the same variable cannot be written again for 2 seconds. On timeout or network error the outcome is unknown; read the variable back to confirm.',
      inputSchema: z
        .object({ name: variableNameSchema, value: variableValueSchema, dry_run: dryRunSchema })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    guard(
      ctx.logger,
      'set_custom_variable',
      async ({ name, value, dry_run }): Promise<ToolOutcome> => {
        const decision = evaluateSetVariable(safety, name);
        if (!decision.allowed) {
          return refused(decision.reason, { name, reason: decision.reason }, dry_run);
        }
        if (dry_run) {
          return {
            summary: `DRY RUN: would POST /api/custom-variable/${name}/value with a ${String(value.length)} character body. Nothing sent.`,
            data: { name, value, dryRun: true, sent: false },
            dryRun: true,
          };
        }
        const slot = limiter.acquire(`variable ${name}`);
        if (!slot.ok) {
          return refused(slot.reason, { name, reason: slot.reason }, false);
        }
        try {
          const intent = ctx.logger.log({
            tool: 'set_custom_variable',
            args: { name, valueLength: value.length },
            outcome: 'attempt',
            allowed: true,
            dryRun: false,
            detail: `about to set custom:${name}`,
          });
          if (!intent) {
            return refused(LOGGER_UNHEALTHY, { name, reason: LOGGER_UNHEALTHY }, false);
          }
          const result = await ctx.client.setCustomVariable(name, value, decision.auth);
          const data = { name, value, dryRun: false, sent: true, result };
          if (result === 'not_found') {
            return {
              summary: `Companion reports custom variable "${name}" does not exist. Nothing changed.`,
              data,
              dryRun: false,
            };
          }
          return {
            summary: `set custom:${name} (${String(value.length)} characters)`,
            data,
            dryRun: false,
          };
        } finally {
          slot.release();
        }
      },
    ),
  );
}
