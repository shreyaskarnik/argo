import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installItem, listItems } from '../../src/hf/add.js';
import type { FetchLike } from '../../src/hf/registry-client.js';

const REG = 'https://example.test/registry';

function stubFetch(routes: Record<string, string | Uint8Array>): FetchLike {
  // Serves both views of a body, like a real Response, so a test can tell
  // whether the installer read bytes or decoded them as text.
  return async (url: string) => {
    const body = routes[url];
    const bytes = body === undefined ? new TextEncoder().encode('not found')
      : typeof body === 'string' ? new TextEncoder().encode(body) : body;
    return {
      ok: body !== undefined,
      status: body !== undefined ? 200 : 404,
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () => bytes.slice().buffer,
    };
  };
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

  it('rejects unsupported registry types with a clear error', async () => {
    const routes = {
      ...ROUTES,
      [`${REG}/registry.json`]: JSON.stringify({
        items: [
          { name: 'vignette', type: 'hyperframes:component' },
          { name: 'widget-x', type: 'hyperframes:widget' },
        ],
      }),
    };
    await expect(
      installItem({ name: 'widget-x', blocksDir: tmp, registryUrl: REG, fetchImpl: stubFetch(routes) }),
    ).rejects.toThrow(/unsupported registry type.*hyperframes:widget/i);
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

  // Registry assets include PNG/JPEG/WAV/WOFF2. Decoding one as UTF-8
  // replaces every invalid byte with U+FFFD, so the install "succeeds" and the
  // file is garbage: a real 74,455-byte registry PNG came out at 135,320.
  it('writes binary assets byte-for-byte', async () => {
    // PNG signature plus bytes that are not valid UTF-8 on their own.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80, 0xc3]);
    const routes = {
      ...ROUTES,
      [`${REG}/components/vignette/registry-item.json`]: JSON.stringify({
        name: 'vignette',
        type: 'hyperframes:component',
        files: [{ path: 'vignette.html' }, { path: 'lava.png' }],
      }),
      [`${REG}/components/vignette/lava.png`]: png,
    };
    await installItem({ name: 'vignette', blocksDir: tmp, registryUrl: REG, fetchImpl: stubFetch(routes) });

    expect(Buffer.from(readFileSync(join(tmp, 'vignette', 'lava.png'))).equals(Buffer.from(png))).toBe(true);
  });

  // 64 of 399 registry items keep assets under subdirectories such as
  // `assets/carousel-images/`, which a flat-only rule refused outright.
  it('installs assets in nested subdirectories', async () => {
    const routes = {
      ...ROUTES,
      [`${REG}/components/vignette/registry-item.json`]: JSON.stringify({
        name: 'vignette',
        type: 'hyperframes:component',
        files: [{ path: 'vignette.html' }, { path: 'assets/sfx/click.wav' }],
      }),
      [`${REG}/components/vignette/assets/sfx/click.wav`]: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0xff]),
    };
    const result = await installItem({ name: 'vignette', blocksDir: tmp, registryUrl: REG, fetchImpl: stubFetch(routes) });

    expect(existsSync(join(tmp, 'vignette', 'assets', 'sfx', 'click.wav'))).toBe(true);
    expect(result.files).toContain('assets/sfx/click.wav');
  });

  // Upstream moved large binary assets off the git registry to a CDN: 396
  // files across 25 items now declare `url`, and nothing exists at the
  // registry path, so installing from `path` alone is a 404.
  it('fetches a file from its declared https url instead of the registry path', async () => {
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    const cdn = 'https://static.example.test/registry-assets/223d162eed10f08f.jpg';
    const routes = {
      ...ROUTES,
      [`${REG}/components/vignette/registry-item.json`]: JSON.stringify({
        name: 'vignette',
        type: 'hyperframes:component',
        files: [{ path: 'vignette.html' }, { path: 'assets/carousel/a.jpg', url: cdn }],
      }),
      [cdn]: jpg,
    };
    await installItem({ name: 'vignette', blocksDir: tmp, registryUrl: REG, fetchImpl: stubFetch(routes) });

    const written = readFileSync(join(tmp, 'vignette', 'assets', 'carousel', 'a.jpg'));
    expect(Buffer.from(written).equals(Buffer.from(jpg))).toBe(true);
  });

  it('refuses a file url that is not https, before writing anything', async () => {
    for (const url of ['http://static.example.test/a.jpg', 'file:///etc/passwd', 'static.example.test/a.jpg']) {
      const routes = {
        ...ROUTES,
        [`${REG}/components/vignette/registry-item.json`]: JSON.stringify({
          name: 'vignette',
          type: 'hyperframes:component',
          files: [{ path: 'vignette.html' }, { path: 'a.jpg', url }],
        }),
      };
      await expect(
        installItem({ name: 'vignette', blocksDir: tmp, registryUrl: REG, fetchImpl: stubFetch(routes) }),
        url,
      ).rejects.toThrow(/must be an absolute https/i);
    }
    expect(existsSync(join(tmp, 'vignette'))).toBe(false);
  });

  it('still rejects nested paths that escape the item directory', async () => {
    const hostile = ['assets/../../x.html', '/abs/x.png', 'assets//x.png', 'assets/.hidden', 'assets\\x.png', 'assets/', './x.html'];
    for (const path of hostile) {
      const routes = {
        ...ROUTES,
        [`${REG}/components/vignette/registry-item.json`]: JSON.stringify({
          name: 'vignette',
          type: 'hyperframes:component',
          files: [{ path }],
        }),
      };
      await expect(
        installItem({ name: 'vignette', blocksDir: tmp, registryUrl: REG, fetchImpl: stubFetch(routes) }),
        path,
      ).rejects.toThrow(/unsafe file path/i);
    }
    // Nothing was written for any rejected manifest.
    expect(existsSync(join(tmp, 'vignette'))).toBe(false);
  });
});

describe('listItems', () => {
  it('returns the raw index', async () => {
    const items = await listItems({ registryUrl: REG, fetchImpl: stubFetch(ROUTES) });
    expect(items).toHaveLength(3);
  });
});
