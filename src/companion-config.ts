/**
 * Config-edit operations against Companion's internal tRPC API (5.0.7).
 * Procedure names and shapes come from reading the Companion source at tag v5.0.7:
 *   companion/lib/Page/Controller.ts, companion/lib/Controls/ControlsTrpcRouter.ts,
 *   companion/lib/Controls/EntitiesTrpcRouter.ts, shared-lib/lib/Model/*.ts
 * Everything Companion returns is validated; a mismatch fails closed.
 */
import { z } from 'zod';
import { WriteAuthorisation, type ButtonLocation } from './authorisation.js';
import {
  COLUMN_MAX,
  COLUMN_MIN,
  CompanionError,
  CONNECTION_ID_RE,
  PAGE_MAX,
  PAGE_MIN,
  ROW_MAX,
  ROW_MIN,
} from './companion-client.js';
import type { TrpcClient } from './trpc-client.js';

/** Button control type in Companion 5.0.7. Older versions used 'button'. */
export const BUTTON_CONTROL_TYPE = 'button-layered';
export const DEFAULT_STEP_ID = '0';
export const PAGE_NAME_MAX = 64;
export const MAX_PAGES_PER_CREATE = 10;
export const ENTITY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const DEFINITION_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
export const OPTION_KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;
export const MAX_OPTIONS = 20;

export type EntityKind = 'action' | 'feedback';
export type ActionSetId = 'down' | 'up' | 'rotate_left' | 'rotate_right';
export type EntityLocation = 'feedbacks' | { readonly stepId: string; readonly setId: ActionSetId };

const pagesInitSchema = z.object({
  type: z.literal('init'),
  order: z.array(z.string().max(128)).max(PAGE_MAX),
  pages: z.record(
    z.string(),
    z.object({
      name: z.string().max(256).optional(),
      controls: z.record(z.string(), z.record(z.string(), z.string().max(128))).optional(),
    }),
  ),
});

const entitySchema = z.object({
  id: z.string().max(128),
  type: z.enum(['action', 'feedback']),
  connectionId: z.string().max(128),
  definitionId: z.string().max(256),
  options: z.record(z.string(), z.unknown()).optional(),
  disabled: z.boolean().optional(),
  headline: z.string().max(256).optional(),
  children: z.record(z.string(), z.array(z.unknown())).optional(),
});

export type Entity = z.infer<typeof entitySchema>;

const buttonConfigSchema = z.object({
  type: z.string().max(64),
  feedbacks: z.array(entitySchema).max(500).optional(),
  steps: z
    .record(
      z.string(),
      z.object({
        action_sets: z.record(z.string(), z.array(entitySchema).max(500).nullable()).optional(),
        options: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});

const controlInitSchema = z.object({
  type: z.literal('init'),
  config: buttonConfigSchema,
});

export interface ButtonSummary {
  readonly controlId: string;
  readonly type: string;
  readonly feedbacks: readonly EntitySummary[];
  readonly steps: Readonly<Record<string, Readonly<Record<string, readonly EntitySummary[]>>>>;
  readonly options: Readonly<Record<string, unknown>>;
}

export interface EntitySummary {
  readonly id: string;
  readonly kind: EntityKind;
  readonly connectionId: string;
  readonly definitionId: string;
  readonly options: Readonly<Record<string, unknown>>;
  readonly disabled: boolean;
  readonly headline?: string;
}

function summariseEntity(e: Entity): EntitySummary {
  return {
    id: e.id,
    kind: e.type,
    connectionId: e.connectionId,
    definitionId: e.definitionId,
    options: e.options ?? {},
    disabled: e.disabled ?? false,
    ...(e.headline === undefined ? {} : { headline: e.headline }),
  };
}

function assertLocation(loc: ButtonLocation): {
  pageNumber: number;
  row: number;
  column: number;
} {
  const ok =
    Number.isInteger(loc.page) &&
    loc.page >= PAGE_MIN &&
    loc.page <= PAGE_MAX &&
    Number.isInteger(loc.row) &&
    loc.row >= ROW_MIN &&
    loc.row <= ROW_MAX &&
    Number.isInteger(loc.column) &&
    loc.column >= COLUMN_MIN &&
    loc.column <= COLUMN_MAX;
  if (!ok) {
    throw new CompanionError('malformed', 'button location out of range');
  }
  return { pageNumber: loc.page, row: loc.row, column: loc.column };
}

function requireButtonAuth(auth: WriteAuthorisation, loc: ButtonLocation, what: string): void {
  if (!(auth instanceof WriteAuthorisation) || !auth.coversButton(loc)) {
    throw new CompanionError('malformed', `${what} not authorised by the safety layer`);
  }
}

function assertPattern(value: string, re: RegExp, label: string): string {
  if (!re.test(value)) {
    throw new CompanionError('malformed', `${label} contains invalid characters or is too long`);
  }
  return value;
}

function isJsonValue(v: unknown, depth = 0): boolean {
  if (depth > 4) {
    return false;
  }
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return true;
  }
  if (Array.isArray(v)) {
    return v.length <= 100 && v.every((x) => isJsonValue(x, depth + 1));
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v);
    return entries.length <= 50 && entries.every(([, x]) => isJsonValue(x, depth + 1));
  }
  return false;
}

export class CompanionConfigClient {
  readonly #trpc: TrpcClient;

  constructor(trpc: TrpcClient) {
    this.#trpc = trpc;
  }

  /** Returns the control id at a location, or undefined if the slot is empty. */
  async resolveControlId(loc: ButtonLocation): Promise<string | undefined> {
    assertLocation(loc);
    const parsed = pagesInitSchema.safeParse(await this.#trpc.first('pages.watch'));
    if (!parsed.success) {
      throw new CompanionError('malformed', 'Companion pages snapshot had an unexpected shape');
    }
    const pageId = parsed.data.order[loc.page - 1];
    if (pageId === undefined) {
      return undefined;
    }
    const page = parsed.data.pages[pageId];
    const id = page?.controls?.[String(loc.row)]?.[String(loc.column)];
    return id === undefined || id === '' ? undefined : id;
  }

  async pageCount(): Promise<number> {
    const parsed = pagesInitSchema.safeParse(await this.#trpc.first('pages.watch'));
    if (!parsed.success) {
      throw new CompanionError('malformed', 'Companion pages snapshot had an unexpected shape');
    }
    return parsed.data.order.length;
  }

  async getButton(loc: ButtonLocation): Promise<ButtonSummary | undefined> {
    const controlId = await this.resolveControlId(loc);
    if (controlId === undefined) {
      return undefined;
    }
    const parsed = controlInitSchema.safeParse(
      await this.#trpc.first('controls.watchControl', { controlId }),
    );
    if (!parsed.success) {
      throw new CompanionError('malformed', 'Companion control snapshot had an unexpected shape');
    }
    const cfg = parsed.data.config;
    const steps: Record<string, Record<string, EntitySummary[]>> = {};
    for (const [stepId, step] of Object.entries(cfg.steps ?? {})) {
      const sets: Record<string, EntitySummary[]> = {};
      for (const [setId, entities] of Object.entries(step.action_sets ?? {})) {
        sets[setId] = (entities ?? []).map(summariseEntity);
      }
      steps[stepId] = sets;
    }
    return {
      controlId,
      type: cfg.type,
      feedbacks: (cfg.feedbacks ?? []).map(summariseEntity),
      steps,
      options: cfg.options ?? {},
    };
  }

  async createButton(loc: ButtonLocation, auth: WriteAuthorisation): Promise<string | undefined> {
    requireButtonAuth(auth, loc, 'create button');
    const location = assertLocation(loc);
    await this.#trpc.call('mutation', 'controls.resetControl', {
      location,
      newType: BUTTON_CONTROL_TYPE,
    });
    return this.resolveControlId(loc);
  }

  async deleteButton(loc: ButtonLocation, auth: WriteAuthorisation): Promise<void> {
    requireButtonAuth(auth, loc, 'delete button');
    const location = assertLocation(loc);
    await this.#trpc.call('mutation', 'controls.resetControl', { location });
  }

  async createPages(
    asPageNumber: number,
    names: readonly string[],
    auth: WriteAuthorisation,
  ): Promise<void> {
    if (!(auth instanceof WriteAuthorisation) || !auth.coversPages()) {
      throw new CompanionError('malformed', 'create page not authorised by the safety layer');
    }
    if (!Number.isInteger(asPageNumber) || asPageNumber < PAGE_MIN || asPageNumber > PAGE_MAX + 1) {
      throw new CompanionError('malformed', 'page number out of range');
    }
    if (names.length === 0 || names.length > MAX_PAGES_PER_CREATE) {
      throw new CompanionError(
        'malformed',
        `1 to ${String(MAX_PAGES_PER_CREATE)} page names required`,
      );
    }
    for (const n of names) {
      if (n.length > PAGE_NAME_MAX) {
        throw new CompanionError('malformed', 'page name too long');
      }
    }
    const result = await this.#trpc.call('mutation', 'pages.insert', {
      asPageNumber,
      pageNames: [...names],
    });
    if (result !== 'ok') {
      throw new CompanionError('malformed', 'Companion did not confirm the page insert');
    }
  }

  async addEntity(
    loc: ButtonLocation,
    controlId: string,
    where: EntityLocation,
    kind: EntityKind,
    connectionId: string,
    definitionId: string,
    auth: WriteAuthorisation,
  ): Promise<string | undefined> {
    requireButtonAuth(auth, loc, 'add entity');
    const result = await this.#trpc.call('mutation', 'controls.entities.add', {
      controlId: assertPattern(controlId, ENTITY_ID_RE, 'control id'),
      entityLocation: where,
      ownerId: null,
      connectionId: assertPattern(connectionId, CONNECTION_ID_RE, 'connection id'),
      entityType: kind,
      entityDefinition: assertPattern(definitionId, DEFINITION_ID_RE, 'definition id'),
    });
    if (result === null) {
      return undefined;
    }
    if (typeof result !== 'string' || !ENTITY_ID_RE.test(result)) {
      throw new CompanionError('malformed', 'Companion returned an unexpected entity id');
    }
    return result;
  }

  async setEntityOption(
    loc: ButtonLocation,
    controlId: string,
    where: EntityLocation,
    entityId: string,
    key: string,
    value: unknown,
    auth: WriteAuthorisation,
  ): Promise<boolean> {
    requireButtonAuth(auth, loc, 'set entity option');
    if (!isJsonValue(value)) {
      throw new CompanionError('malformed', 'option value must be plain JSON');
    }
    const result = await this.#trpc.call('mutation', 'controls.entities.setOption', {
      controlId: assertPattern(controlId, ENTITY_ID_RE, 'control id'),
      entityLocation: where,
      entityId: assertPattern(entityId, ENTITY_ID_RE, 'entity id'),
      key: assertPattern(key, OPTION_KEY_RE, 'option key'),
      value,
    });
    return result === true;
  }

  async removeEntity(
    loc: ButtonLocation,
    controlId: string,
    where: EntityLocation,
    entityId: string,
    auth: WriteAuthorisation,
  ): Promise<boolean> {
    requireButtonAuth(auth, loc, 'remove entity');
    const result = await this.#trpc.call('mutation', 'controls.entities.remove', {
      controlId: assertPattern(controlId, ENTITY_ID_RE, 'control id'),
      entityLocation: where,
      entityId: assertPattern(entityId, ENTITY_ID_RE, 'entity id'),
    });
    return result === true;
  }
}

/** Find where an entity lives on a button, from a snapshot. */
export function locateEntity(button: ButtonSummary, entityId: string): EntityLocation | undefined {
  if (button.feedbacks.some((f) => f.id === entityId)) {
    return 'feedbacks';
  }
  for (const [stepId, sets] of Object.entries(button.steps)) {
    for (const [setId, entities] of Object.entries(sets)) {
      if (entities.some((e) => e.id === entityId)) {
        if (
          setId === 'down' ||
          setId === 'up' ||
          setId === 'rotate_left' ||
          setId === 'rotate_right'
        ) {
          return { stepId, setId };
        }
      }
    }
  }
  return undefined;
}
