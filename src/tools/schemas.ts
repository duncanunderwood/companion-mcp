import { z } from 'zod';
import {
  COLUMN_MAX,
  COLUMN_MIN,
  CONNECTION_ID_RE,
  CONNECTION_LABEL_RE,
  PAGE_MAX,
  PAGE_MIN,
  ROW_MAX,
  ROW_MIN,
  VARIABLE_NAME_RE,
} from '../companion-client.js';

export const pageSchema = z
  .number()
  .int()
  .min(PAGE_MIN)
  .max(PAGE_MAX)
  .describe(`Page number, ${String(PAGE_MIN)} to ${String(PAGE_MAX)}`);
export const rowSchema = z
  .number()
  .int()
  .min(ROW_MIN)
  .max(ROW_MAX)
  .describe(`Row, 0 based, ${String(ROW_MIN)} to ${String(ROW_MAX)}`);
export const columnSchema = z
  .number()
  .int()
  .min(COLUMN_MIN)
  .max(COLUMN_MAX)
  .describe(`Column, 0 based, ${String(COLUMN_MIN)} to ${String(COLUMN_MAX)}`);

export const variableNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(VARIABLE_NAME_RE, 'letters, digits, underscore and hyphen only')
  .describe('Variable name without the $(...) wrapper');

export const connectionLabelSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(CONNECTION_LABEL_RE, 'letters, digits, underscore and hyphen only')
  .describe('Connection label as shown in Companion');

export const connectionIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(CONNECTION_ID_RE, 'letters, digits, underscore and hyphen only')
  .describe('Connection id as returned by list_connections');

export const variableValueSchema = z
  .string()
  .max(1000)
  .describe('New value, stored as text, maximum 1000 characters');

export const dryRunSchema = z
  .boolean()
  .default(true)
  .describe('When true (default) nothing is sent to Companion. Pass false to act.');

export const confirmSchema = z
  .boolean()
  .default(false)
  .describe('Required true for high risk allowlist entries');
