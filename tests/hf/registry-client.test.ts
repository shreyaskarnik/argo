import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REGISTRY_URL,
  kindFromType,
  fetchRegistryIndex,
  fetchRegistryItem,
  fetchItemFile,
  type FetchLike,
} from '../../src/hf/registry-client.js';

function stubFetch(routes: Record<string, string>): FetchLike {
  return async (url: string) => {
    const body = routes[url];
    return {
      ok: body !== undefined,
      status: body !== undefined ? 200 : 404,
      text: async () => body ?? 'not found',
    };
  };
}

const REG = 'https://example.test/registry';

describe('registry client', () => {
  it('exposes the hyperframes default registry URL', () => {
    expect(DEFAULT_REGISTRY_URL).toBe(
      'https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry',
    );
  });

  it('maps registry item types to fetch kinds', () => {
    expect(kindFromType('hyperframes:block')).toBe('blocks');
    expect(kindFromType('hyperframes:component')).toBe('components');
    expect(kindFromType('hyperframes:example')).toBe(null);
    expect(kindFromType('bogus')).toBe(null);
  });

  it('fetches and parses the registry index', async () => {
    const f = stubFetch({
      [`${REG}/registry.json`]: JSON.stringify({
        items: [{ name: 'vignette', type: 'hyperframes:component' }],
      }),
    });
    const items = await fetchRegistryIndex(REG, f);
    expect(items).toEqual([{ name: 'vignette', type: 'hyperframes:component' }]);
  });

  it('fetches and parses a registry item', async () => {
    const f = stubFetch({
      [`${REG}/components/vignette/registry-item.json`]: JSON.stringify({
        name: 'vignette',
        type: 'hyperframes:component',
        files: [{ path: 'vignette.html' }],
      }),
    });
    const item = await fetchRegistryItem(REG, 'components', 'vignette', f);
    expect(item.name).toBe('vignette');
    expect(item.files).toHaveLength(1);
  });

  it('fetches raw item file content', async () => {
    const f = stubFetch({
      [`${REG}/components/vignette/vignette.html`]: '<div id="hf-vignette"></div>',
    });
    await expect(fetchItemFile(REG, 'components', 'vignette', 'vignette.html', f)).resolves.toContain(
      'hf-vignette',
    );
  });

  it('throws a clear error on HTTP failure', async () => {
    const f = stubFetch({});
    await expect(fetchRegistryIndex(REG, f)).rejects.toThrow(/registry.*404/i);
  });

  it('throws a clear error on malformed index JSON', async () => {
    const f = stubFetch({ [`${REG}/registry.json`]: '{"nope": true}' });
    await expect(fetchRegistryIndex(REG, f)).rejects.toThrow(/items/i);
  });
});
