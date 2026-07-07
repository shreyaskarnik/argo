import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installItem, listItems } from '../../src/hf/add.js';
import type { FetchLike } from '../../src/hf/registry-client.js';

const REG = 'https://example.test/registry';

function stubFetch(routes: Record<string, string>): FetchLike {
  return async (url: string) => ({
    ok: routes[url] !== undefined,
    status: routes[url] !== undefined ? 200 : 404,
    text: async () => routes[url] ?? 'not found',
  });
}

const ROUTES = {
  [`${REG}/registry.json`]: JSON.stringify({
    items: [
      { name: 'vignette', type: 'hyperframes:component' },
      { name: 'logo-outro', type: 'hyperframes:block' },
      { name: 'warm-grain', type: 'hyperframes:example' },
    ],
  }),
  [`${REG}/components/vignette/registry-item.json`]: JSON.stringify({
    name: 'vignette',
    type: 'hyperframes:component',
    files: [{ path: 'vignette.html' }],
  }),
  [`${REG}/components/vignette/vignette.html`]: '<div id="hf-vignette"></div>',
};

describe('installItem', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'argo-add-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('installs a component: files + registry-item.json under blocksDir/<name>/', async () => {
    const result = await installItem({
      name: 'vignette', blocksDir: tmp, registryUrl: REG, fetchImpl: stubFetch(ROUTES),
    });
    expect(result.kind).toBe('components');
    expect(existsSync(join(tmp, 'vignette', 'vignette.html'))).toBe(true);
    expect(existsSync(join(tmp, 'vignette', 'registry-item.json'))).toBe(true);
    expect(readFileSync(join(tmp, 'vignette', 'vignette.html'), 'utf-8')).toContain('hf-vignette');
    expect(result.files).toContain('vignette.html');
  });

  it('rejects invalid item names (path traversal guard)', async () => {
    for (const bad of ['../evil', 'a/b', '.hidden', 'name!']) {
      await expect(
        installItem({ name: bad, blocksDir: tmp, registryUrl: REG, fetchImpl: stubFetch(ROUTES) }),
      ).rejects.toThrow(/invalid item name/i);
    }
  });

  it('rejects example items with a helpful error', async () => {
    await expect(
      installItem({ name: 'warm-grain', blocksDir: tmp, registryUrl: REG, fetchImpl: stubFetch(ROUTES) }),
    ).rejects.toThrow(/example.*not installable/i);
  });

  it('rejects unknown items pointing at --list', async () => {
    await expect(
      installItem({ name: 'nope', blocksDir: tmp, registryUrl: REG, fetchImpl: stubFetch(ROUTES) }),
    ).rejects.toThrow(/not found.*--list/is);
  });

  it('rejects item files with unsafe paths', async () => {
    const routes = {
      ...ROUTES,
      [`${REG}/components/vignette/registry-item.json`]: JSON.stringify({
        name: 'vignette',
        type: 'hyperframes:component',
        files: [{ path: '../../etc/passwd' }],
      }),
    };
    await expect(
      installItem({ name: 'vignette', blocksDir: tmp, registryUrl: REG, fetchImpl: stubFetch(routes) }),
    ).rejects.toThrow(/unsafe file path/i);
  });
});

describe('listItems', () => {
  it('returns the raw index', async () => {
    const items = await listItems({ registryUrl: REG, fetchImpl: stubFetch(ROUTES) });
    expect(items).toHaveLength(3);
  });
});
