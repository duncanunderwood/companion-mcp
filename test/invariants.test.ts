import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const srcDir = path.resolve(__dirname, '../src');

function readAll(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [k, v] of readAll(full)) {
        out.set(k, v);
      }
    } else if (entry.name.endsWith('.ts')) {
      out.set(path.relative(srcDir, full).replaceAll('\\', '/'), readFileSync(full, 'utf8'));
    }
  }
  return out;
}

const files = readAll(srcDir);

describe('structural invariants', () => {
  it('only companion-client.ts performs HTTP requests', () => {
    for (const [name, text] of files) {
      if (name === 'companion-client.ts') {
        continue;
      }
      expect(text, name).not.toMatch(/\bfetch\s*\(/);
      expect(text, name).not.toMatch(/node:http/);
    }
  });

  const writeMethods = [
    'pressButton',
    'buttonAction',
    'setButtonStep',
    'setButtonStyle',
    'setCustomVariable',
    'connectionAction',
    'rescanSurfaces',
  ];

  it('client write methods are only called from write-tools, each inside performWrite', () => {
    // eslint-disable-next-line security/detect-non-literal-regexp -- fixed list of method names
    const re = new RegExp(`\\.(${writeMethods.join('|')})\\(`);
    const callers = [...files.entries()].filter(
      ([name, text]) => name !== 'companion-client.ts' && re.test(text),
    );
    expect(callers.map(([n]) => n)).toEqual(['tools/write-tools.ts']);
    const text = files.get('tools/write-tools.ts') ?? '';
    for (const m of writeMethods) {
      const idx = text.indexOf(`.${m}(`);
      expect(idx, m).toBeGreaterThan(0);
      const before = text.slice(0, idx);
      expect(before.lastIndexOf('performWrite('), m).toBeGreaterThan(
        before.lastIndexOf('registerTool('),
      );
      expect(before.lastIndexOf('if (!decision.allowed)'), m).toBeGreaterThan(
        before.lastIndexOf('registerTool('),
      );
    }
  });

  it('every client write method requires a WriteAuthorisation', () => {
    const text = files.get('companion-client.ts') ?? '';
    for (const m of writeMethods) {
      if (m === 'pressButton') {
        continue;
      }
      const idx = text.indexOf(`async ${m}(`);
      expect(idx, m).toBeGreaterThan(0);
      const bodyStart = text.indexOf('{', text.indexOf(')', idx));
      const head = text.slice(bodyStart, bodyStart + 400);
      expect(head, m).toMatch(/requireAuth\(/);
    }
  });

  it('safety decisions check both allowlist and write gate', () => {
    const text = files.get('safety.ts') ?? '';
    expect(text).toMatch(/isWriteEnabled\(ctx\)/);
    expect(text).toMatch(/getButtonEntry\(ctx\.allowlist/);
    expect(text).toMatch(/isVariableAllowed\(ctx\.allowlist/);
  });

  it('no retry logic exists', () => {
    for (const [name, text] of files) {
      expect(text, name).not.toMatch(/retr(y|ies)/i);
    }
  });

  it('no legacy Companion endpoints are referenced', () => {
    for (const [name, text] of files) {
      expect(text, name).not.toMatch(/press\/bank|style\/bank|set\/custom-variable|['"`]\/rescan/);
    }
  });

  it('no dashes other than hyphens', () => {
    for (const [name, text] of files) {
      expect(text, name).not.toMatch(/[\u2013\u2014]/);
    }
  });
});
