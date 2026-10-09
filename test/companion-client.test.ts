import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CompanionClient, CompanionError } from '../src/companion-client.js';
import { MockCompanion } from './mock-companion.js';

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
  it('returns found false on 404', async () => {
    expect(await client.getCustomVariable('nope')).toEqual({ found: false });
  });
  it('rejects invalid names before any request', async () => {
    await expect(client.getCustomVariable('../x')).rejects.toThrow(CompanionError);
    expect(mock.requests).toHaveLength(0);
  });
  it('throws timeout with kind timeout', async () => {
    mock.mode = 'hang';
    const err = await client.getCustomVariable('cue').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CompanionError);
    expect((err as CompanionError).kind).toBe('timeout');
  });
  it('throws malformed on bad json', async () => {
    mock.mode = 'garbage';
    const err = await client.getCustomVariable('cue').catch((e: unknown) => e);
    expect((err as CompanionError).kind).toBe('malformed');
  });
  it('reports api disabled on 403', async () => {
    mock.mode = 'disabled';
    const err = await client.getCustomVariable('cue').catch((e: unknown) => e);
    expect((err as CompanionError).status).toBe(403);
    expect((err as CompanionError).message).toMatch(/disabled/);
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
  it('lists and gets status', async () => {
    mock.connections = [
      {
        id: 'abc',
        label: 'OBS',
        moduleId: 'obs',
        enabled: true,
        sortOrder: 0,
        status: { category: 'good', level: 'ok', message: 'Connected' },
      },
    ];
    const list = await client.listConnections();
    expect(list[0]?.label).toBe('OBS');
    const st = await client.getConnectionStatus('abc');
    expect(st.found && st.connection.id).toBe('abc');
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
    expect(await client.pressButton({ page: 1, row: 0, column: 0 })).toBe('ok');
    expect(mock.requests[0]).toMatchObject({ method: 'POST', path: '/api/location/1/0/0/press' });
  });
  it('reports no_control on 204', async () => {
    expect(await client.pressButton({ page: 1, row: 0, column: 1 })).toBe('no_control');
  });
  it('rejects out of range or non integer locations before any request', async () => {
    await expect(client.pressButton({ page: 100, row: 0, column: 0 })).rejects.toThrow(
      CompanionError,
    );
    await expect(client.pressButton({ page: 1, row: 1.5, column: 0 })).rejects.toThrow(
      CompanionError,
    );
    await expect(client.pressButton({ page: 1, row: 0, column: -1 })).rejects.toThrow(
      CompanionError,
    );
    expect(mock.requests).toHaveLength(0);
  });
  it('sends exactly one request on timeout', async () => {
    mock.mode = 'hang';
    const err = await client.pressButton({ page: 1, row: 0, column: 0 }).catch((e: unknown) => e);
    expect((err as CompanionError).kind).toBe('timeout');
    expect(mock.requests).toHaveLength(1);
  });
});

describe('setCustomVariable', () => {
  it('posts plain text body and never puts the value in the url', async () => {
    mock.customVariables.set('cue', 'old');
    expect(await client.setCustomVariable('cue', 'new value')).toBe('ok');
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
    expect(await client.setCustomVariable('missing', 'x')).toBe('not_found');
  });
});

describe('network errors', () => {
  it('reports network kind when Companion is down', async () => {
    const dead = new CompanionClient(new URL('http://127.0.0.1:1'), 300);
    const err = await dead.getCustomVariable('cue').catch((e: unknown) => e);
    expect((err as CompanionError).kind).toBe('network');
  });
});
