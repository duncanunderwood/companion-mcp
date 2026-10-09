import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { guard, type ToolOutcome } from '../guard.js';
import { evaluatePress, evaluateSetVariable, locationKey } from '../safety.js';
import {
  columnSchema,
  confirmSchema,
  dryRunSchema,
  pageSchema,
  rowSchema,
  variableNameSchema,
  variableValueSchema,
} from './schemas.js';

export function registerWriteTools(server: McpServer, ctx: AppContext): void {
  const safety = { allowWrites: ctx.config.allowWrites, allowlist: ctx.allowlist };

  server.registerTool(
    'press_button',
    {
      title: 'Press button',
      description:
        'Press and release a Companion button at page/row/column. ONLY buttons on the allowlist (see list_allowlist) can be pressed; anything else is refused. Defaults to dry_run: true which reports what would be sent without sending it. To actually press, pass dry_run: false. High risk buttons also need confirm: true. One attempt only, never retried. A result of "ok" means Companion accepted the press, not that the downstream device acted; verify by reading a variable back. On timeout the outcome is unknown.',
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
        const decision = evaluatePress(safety, loc, { confirm });
        if (!decision.allowed) {
          return {
            summary: `REFUSED: ${decision.reason}`,
            data: { location: loc, refused: true, reason: decision.reason },
            refused: true,
            dryRun: dry_run,
          };
        }
        const entry = decision.entry;
        if (dry_run) {
          return {
            summary: `DRY RUN: would POST /api/location/${locationKey(loc)}/press for "${entry.label}" (risk ${entry.risk}). Nothing sent.`,
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
        const result = await ctx.client.pressButton(loc);
        if (result === 'no_control') {
          return {
            summary: `Companion reports no button at ${locationKey(loc)} ("${entry.label}" in allowlist). Allowlist may be stale.`,
            data: { location: loc, label: entry.label, dryRun: false, sent: true, result },
            dryRun: false,
          };
        }
        return {
          summary: `pressed "${entry.label}" at ${locationKey(loc)}. Companion accepted the press.`,
          data: { location: loc, label: entry.label, dryRun: false, sent: true, result },
          dryRun: false,
        };
      },
    ),
  );

  server.registerTool(
    'set_custom_variable',
    {
      title: 'Set custom variable',
      description:
        'Set a Companion custom variable to a text value. ONLY variable names on the allowlist (see list_allowlist) can be set. Defaults to dry_run: true which reports what would be sent without sending it. Pass dry_run: false to actually write. One attempt only, never retried. On timeout the outcome is unknown; read the variable back to confirm.',
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
          return {
            summary: `REFUSED: ${decision.reason}`,
            data: { name, refused: true, reason: decision.reason },
            refused: true,
            dryRun: dry_run,
          };
        }
        if (dry_run) {
          return {
            summary: `DRY RUN: would POST /api/custom-variable/${name}/value with body "${value}". Nothing sent.`,
            data: { name, value, dryRun: true, sent: false },
            dryRun: true,
          };
        }
        const result = await ctx.client.setCustomVariable(name, value);
        if (result === 'not_found') {
          return {
            summary: `Companion reports custom variable "${name}" does not exist. Nothing changed.`,
            data: { name, value, dryRun: false, sent: true, result },
            dryRun: false,
          };
        }
        return {
          summary: `set custom:${name} = "${value}"`,
          data: { name, value, dryRun: false, sent: true, result },
          dryRun: false,
        };
      },
    ),
  );
}
