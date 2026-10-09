import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CompanionClient, CompanionError } from '../src/companion-client.js';
import { evaluatePress, evaluateSetVariable } from '../src/safety.js';
import { testAllowlist } from './helpers.js';
import { MockCompanion } from './mock-companion.js';

const ctx = { allowWrites: true, allowlist: testAllowlist };
function pressAuth(loc: { page: number; row: number; column: number }) {
  const d = evaluatePress(ctx, loc, { confirm: true });
  if (!d.allowed) {
    throw new Error(d.reason);
  }
  return d.auth;
}
function varAuth(name: string) {
  const d = evaluateSetVariable(ctx, name);
  if (!d.allowed) {
    throw new Error(d.reason);
  }
  return d.auth;
}
const low = { page: 1, row: 0, column: 0 };
const lowAuth = pressAuth(low);
const cueAuth = varAuth('cue');

const mock = new MockCompanion();
let client: CompanionClient;

beforeAll(async () => {
  await mock.start();
  client = new CompanionClient(mock.url, 300);
});
afterAll(async () => {
  await mock.stop();
});
beforeEach(() => {
  mock.mode = 'normal';
  mock.requests.length = 0;
  mock.customVariables.clear();
  mock.moduleVariables.clear();
  mock.buttons.clear();
  mock.connections = [];
});

function asErr(p: Promise<unknown>): Promise<CompanionError> {
  return p.then(
    () => {
      throw new Error('expected rejection');
    },
    (e: unknown) => e as CompanionError,
  );
}

describe('getCustomVariable', () => {
  it('returns text, number and json values', async () => {
    mock.customVariables.set('cue', 'intro');
    mock.customVariables.set('count', 42);
    mock.customVariables.set('obj', { a: 1 });
    expect(await client.getCustomVariable('cue')).toEqual({ found: true, value: 'intro' });
    expect(await client.getCustomVariable('count')).toEqual({ found: true, value: '42' });
    expect(await client.getCustomVariable('obj')).toEqual({ found: true, value: { a: 1 } });
    expect(mock.requests[0]?.path).toBe('/api/custom-variable/cue/value');
  });
  it('returns found false on a documented 404', async () => {
    expect(await client.getCustomVariable('nope')).toEqual({ found: false });
  });
  it('rejects invalid names before any request', async () => {
    await expect(client.getCustomVariable('../x')).rejects.toThrow(CompanionError);
    expect(mock.requests).toHaveLength(0);
  });
  it('throws timeout with kind timeout', async () => {
    mock.mode = 'hang';
    const err = await asErr(client.getCustomVariable('cue'));
    expect(err.kind).toBe('timeout');
    expect(err.writeAttempted).toBe(false);
  });
  it('throws malformed on bad json', async () => {
    mock.mode = 'garbage';
    expect((await asErr(client.getCustomVariable('cue'))).kind).toBe('malformed');
  });
  it('reports api disabled on 403', async () => {
    mock.mode = 'disabled';
    const err = await asErr(client.getCustomVariable('cue'));
    expect(err.status).toBe(403);
    expect(err.message).toMatch(/disabled/);
  });
  it('does not follow redirects', async () => {
    mock.mode = 'redirect';
    expect((await asErr(client.getCustomVariable('cue'))).kind).toBe('network');
  });
  it('rejects oversized responses', async () => {
    mock.mode = 'huge';
    await expect(client.getCustomVariable('cue')).rejects.toThrow(/too large/);
  });
  it('treats a 404 with an unexpected body as an error, not not-found', async () => {
    mock.mode = 'empty404';
    await expect(client.getCustomVariable('cue')).rejects.toThrow(
      /unexpected Companion response 404/,
    );
    await expect(client.getConnectionStatus('abc')).rejects.toThrow(
      /unexpected Companion response 404/,
    );
    await expect(client.setCustomVariable('cue', 'x', cueAuth)).rejects.toThrow(/404/);
  });
});

describe('getModuleVariable', () => {
  it('reads and 404s', async () => {
    mock.moduleVariables.set('atem:program', 'Cam 1');
    expect(await client.getModuleVariable('atem', 'program')).toEqual({
      found: true,
      value: 'Cam 1',
    });
    expect(await client.getModuleVariable('atem', 'missing')).toEqual({ found: false });
    expect(mock.requests[0]?.path).toBe('/api/variable/atem/program/value');
  });
  it('rejects bad labels', async () => {
    await expect(client.getModuleVariable('a b', 'x')).rejects.toThrow(CompanionError);
  });
});

describe('connections', () => {
  it('lists and gets status, stripping undocumented fields', async () => {
    mock.connections = [
      {
        id: 'abc',
        label: 'OBS',
        moduleId: 'obs',
        enabled: true,
        sortOrder: 0,
        status: { category: 'good', level: 'ok', message: 'Connected' },
        internalSecret: 'leak',
      },
    ];
    const list = await client.listConnections();
    expect(list[0]?.label).toBe('OBS');
    expect(JSON.stringify(list)).not.toContain('leak');
    const st = await client.getConnectionStatus('abc');
    expect(st.found && st.connection.id).toBe('abc');
    expect(JSON.stringify(st)).not.toContain('leak');
    expect(await client.getConnectionStatus('zzz')).toEqual({ found: false });
  });
  it('rejects unexpected shapes', async () => {
    mock.connections = [{ nope: true }];
    await expect(client.listConnections()).rejects.toThrow(/unexpected shape/);
  });
  it('throws malformed on garbage', async () => {
    mock.mode = 'garbage';
    await expect(client.listConnections()).rejects.toThrow(/malformed/);
    await expect(client.getConnectionStatus('abc')).rejects.toThrow(/malformed/);
  });
});

describe('pressButton', () => {
  it('posts to the location press path and reports ok', async () => {
    mock.buttons.add('1/0/0');
    expect(await client.pressButton(low, lowAuth)).toBe('ok');
    expect(mock.requests[0]).toMatchObject({ method: 'POST', path: '/api/location/1/0/0/press' });
  });
  it('reports no_control on 204', async () => {
    expect(await client.pressButton(low, lowAuth)).toBe('no_control');
  });
  it('rejects out of range or non integer locations before any request', async () => {
    const bad = [
      { page: 100, row: 0, column: 0 },
      { page: 1, row: 1.5, column: 0 },
      { page: 1, row: 0, column: -1 },
    ];
    for (const loc of bad) {
      await expect(client.pressButton(loc, lowAuth)).rejects.toThrow(CompanionError);
    }
    expect(mock.requests).toHaveLength(0);
  });
  it('refuses without a matching authorisation and never sends', async () => {
    const other = pressAuth({ page: 1, row: 3, column: 7 });
    await expect(client.pressButton(low, other)).rejects.toThrow(/not authorised/);
    const fake = { coversButton: () => true, coversVariable: () => true };
    await expect(client.pressButton(low, fake as unknown as typeof lowAuth)).rejects.toThrow(
      /not authorised/,
    );
    await expect(client.setCustomVariable('cue', 'x', other)).rejects.toThrow(/not authorised/);
    expect(mock.requests).toHaveLength(0);
  });
  it('sends exactly one request on timeout and flags writeAttempted', async () => {
    mock.mode = 'hang';
    const err = await asErr(client.pressButton(low, lowAuth));
    expect(err.kind).toBe('timeout');
    expect(err.writeAttempted).toBe(true);
    expect(mock.requests).toHaveLength(1);
  });
  it('marks writeAttempted on reset and 5xx, not on 403', async () => {
    mock.mode = 'reset';
    const r = await asErr(client.pressButton(low, lowAuth));
    expect(r.kind).toBe('network');
    expect(r.writeAttempted).toBe(true);
    mock.mode = 'server-error';
    const s = await asErr(client.pressButton(low, lowAuth));
    expect(s.status).toBe(500);
    expect(s.writeAttempted).toBe(true);
    mock.mode = 'disabled';
    expect((await asErr(client.pressButton(low, lowAuth))).writeAttempted).toBe(false);
  });
});

describe('setCustomVariable', () => {
  it('posts plain text body and never puts the value in the url', async () => {
    mock.customVariables.set('cue', 'old');
    expect(await client.setCustomVariable('cue', 'new value', cueAuth)).toBe('ok');
    const req = mock.requests[0];
    expect(req).toMatchObject({
      method: 'POST',
      path: '/api/custom-variable/cue/value',
      body: 'new value',
    });
    expect(req?.contentType).toBe('text/plain');
    expect(mock.customVariables.get('cue')).toBe('new value');
  });
  it('reports not_found', async () => {
    expect(await client.setCustomVariable('cue', 'x', cueAuth)).toBe('not_found');
  });
  it('rejects blank values locally', async () => {
    await expect(client.setCustomVariable('cue', '   ', cueAuth)).rejects.toThrow(/empty/);
    expect(mock.requests).toHaveLength(0);
  });
});

describe('network errors', () => {
  it('reports network kind when Companion is down', async () => {
    const dead = new CompanionClient(new URL('http://127.0.0.1:1'), 300);
    expect((await asErr(dead.getCustomVariable('cue'))).kind).toBe('network');
  });
});
