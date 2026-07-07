# `argo add` + HyperFrames Registry Compatibility — Implementation Plan (Track 2 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `argo add <name>` installs blocks/components from the hyperframes registry into a project-local `blocks/` dir, and installed **components** become usable during recording via a new `hf-component` overlay cue and a script-side `applyComponent()` API.

**Architecture:** Items are stored as native hyperframes HTML (verbatim) and adapted at use time — never converted to argo's `BlockDefinition` format. New `src/hf/` module family: `registry-client.ts` (fetch), `add.ts` (install), `component.ts` (snippet parser + param safety), `apply-component.ts` (page injection). Config gains `blocksDir` (default `'blocks'`) and `registry?: { url?: string }`. The blocks dir bridges to the Playwright subprocess via `ARGO_BLOCKS_DIR` (set in `record.ts`, passed at all three `record()` call sites).

**Tech Stack:** TypeScript (strict, ESM, ES2022), vitest, Node 24 global `fetch`, Playwright chromium for the one injection integration test.

**Spec:** `docs/superpowers/specs/2026-07-06-hyperframes-integration-design.md` (Track 2 section)

## Global Constraints

- Branch: `feat/hyperframes-integration` (exists). Commit with `git -c commit.gpgsign=false commit ...`.
- Default registry URL: `https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry`.
- Registry index lives at `<registryUrl>/registry.json` with shape `{ items: [{ name, type }] }` where type ∈ `hyperframes:block | hyperframes:component | hyperframes:example`. Item metadata: `<registryUrl>/<blocks|components>/<name>/registry-item.json`; item files: `<registryUrl>/<blocks|components>/<name>/<file.path>`.
- Item names AND item file paths must be validated against `/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/` (no slashes) before any `path.join()` — path-traversal invariant. Item *names* use the stricter demo-name pattern `/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/`.
- `hyperframes:example` items are NOT installable — reject with a clear error.
- Caption components (`caption-*`) install fine but are NOT given special support (word timing is out of scope — deferred to the STT track).
- Unit tests must NOT hit the network — inject a fetch stub. Exactly one Playwright integration test (Task 5).
- Env bridge rule: config→Playwright vars are set in `src/record.ts` and passed at ALL THREE `record()` call sites: `src/pipeline.ts:172`, `src/pipeline.ts:527`, `src/cli.ts:93`.
- README/CLAUDE.md/skill sync happens in the final task.
- Run single test file: `npx vitest run tests/path/to/test.ts`. Full suite: `npm test`.

---

### Task 1: Registry client

**Files:**
- Create: `src/hf/registry-client.ts`
- Test: `tests/hf/registry-client.test.ts`

**Interfaces:**
- Consumes: nothing (fetch injected).
- Produces (Task 2 depends on these exact names):
  - `DEFAULT_REGISTRY_URL: string`
  - `type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>`
  - `interface RegistryIndexItem { name: string; type: string }`
  - `interface RegistryItemFile { path: string; target?: string; type?: string }`
  - `interface RegistryItem { name: string; type: string; title?: string; description?: string; tags?: string[]; files: RegistryItemFile[]; params?: Array<{ key: string; label?: string; type?: string; default?: string }> }`
  - `kindFromType(t: string): 'blocks' | 'components' | null`
  - `fetchRegistryIndex(registryUrl: string, fetchImpl?: FetchLike): Promise<RegistryIndexItem[]>`
  - `fetchRegistryItem(registryUrl: string, kind: 'blocks' | 'components', name: string, fetchImpl?: FetchLike): Promise<RegistryItem>`
  - `fetchItemFile(registryUrl: string, kind: 'blocks' | 'components', name: string, filePath: string, fetchImpl?: FetchLike): Promise<string>`

- [ ] **Step 1: Write the failing test**

Create `tests/hf/registry-client.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/hf/registry-client.test.ts`
Expected: FAIL — `Cannot find module '../../src/hf/registry-client.js'`

- [ ] **Step 3: Write the implementation**

Create `src/hf/registry-client.ts`:

```typescript
/**
 * Minimal client for the hyperframes registry layout:
 *   <registryUrl>/registry.json
 *   <registryUrl>/<blocks|components>/<name>/registry-item.json
 *   <registryUrl>/<blocks|components>/<name>/<file.path>
 * Fetch is injectable so unit tests never touch the network.
 */

export const DEFAULT_REGISTRY_URL =
  'https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry';

export type FetchLike = (
  url: string,
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface RegistryIndexItem {
  name: string;
  type: string;
}

export interface RegistryItemFile {
  path: string;
  target?: string;
  type?: string;
}

export interface RegistryItem {
  name: string;
  type: string;
  title?: string;
  description?: string;
  tags?: string[];
  files: RegistryItemFile[];
  params?: Array<{ key: string; label?: string; type?: string; default?: string }>;
}

/** Registry item type → URL path segment. Examples are not installable. */
export function kindFromType(t: string): 'blocks' | 'components' | null {
  if (t === 'hyperframes:block') return 'blocks';
  if (t === 'hyperframes:component') return 'components';
  return null;
}

async function fetchText(url: string, fetchImpl: FetchLike): Promise<string> {
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`Registry fetch failed (${res.status}): ${url}`);
  }
  return res.text();
}

export async function fetchRegistryIndex(
  registryUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<RegistryIndexItem[]> {
  const raw = await fetchText(`${registryUrl}/registry.json`, fetchImpl);
  const parsed = JSON.parse(raw) as { items?: RegistryIndexItem[] };
  if (!Array.isArray(parsed.items)) {
    throw new Error(`Malformed registry index: expected an "items" array at ${registryUrl}/registry.json`);
  }
  return parsed.items;
}

export async function fetchRegistryItem(
  registryUrl: string,
  kind: 'blocks' | 'components',
  name: string,
  fetchImpl: FetchLike = fetch,
): Promise<RegistryItem> {
  const raw = await fetchText(`${registryUrl}/${kind}/${name}/registry-item.json`, fetchImpl);
  const item = JSON.parse(raw) as RegistryItem;
  if (!item.name || !Array.isArray(item.files)) {
    throw new Error(`Malformed registry-item.json for "${name}": missing name or files`);
  }
  return item;
}

export async function fetchItemFile(
  registryUrl: string,
  kind: 'blocks' | 'components',
  name: string,
  filePath: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  return fetchText(`${registryUrl}/${kind}/${name}/${filePath}`, fetchImpl);
}
```

Note: the error message for HTTP failure contains "Registry fetch failed (404)" which satisfies the test's `/registry.*404/i`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/hf/registry-client.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/hf/registry-client.ts tests/hf/registry-client.test.ts
git -c commit.gpgsign=false commit -m "feat(hf): hyperframes registry client with injectable fetch"
```

---

### Task 2: Installer

**Files:**
- Create: `src/hf/add.ts`
- Test: `tests/hf/add.test.ts`

**Interfaces:**
- Consumes: everything from Task 1's `registry-client.ts` (exact names above).
- Produces (Task 3 depends on):
  - `interface InstallResult { name: string; kind: 'blocks' | 'components'; files: string[]; targetDir: string }`
  - `installItem(opts: { name: string; blocksDir: string; registryUrl?: string; fetchImpl?: FetchLike }): Promise<InstallResult>`
  - `listItems(opts: { registryUrl?: string; fetchImpl?: FetchLike }): Promise<RegistryIndexItem[]>`

- [ ] **Step 1: Write the failing test**

Create `tests/hf/add.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/hf/add.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/hf/add.ts`:

```typescript
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_REGISTRY_URL,
  fetchItemFile,
  fetchRegistryIndex,
  fetchRegistryItem,
  kindFromType,
  type FetchLike,
  type RegistryIndexItem,
} from './registry-client.js';

/** Same pattern the CLI uses for demo names — path-traversal guard. */
const ITEM_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
/** Item file paths must be flat (no slashes) — e.g. "vignette.html". */
const ITEM_FILE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export interface InstallResult {
  name: string;
  kind: 'blocks' | 'components';
  files: string[];
  targetDir: string;
}

export async function listItems(opts: {
  registryUrl?: string;
  fetchImpl?: FetchLike;
}): Promise<RegistryIndexItem[]> {
  return fetchRegistryIndex(opts.registryUrl ?? DEFAULT_REGISTRY_URL, opts.fetchImpl ?? fetch);
}

export async function installItem(opts: {
  name: string;
  blocksDir: string;
  registryUrl?: string;
  fetchImpl?: FetchLike;
}): Promise<InstallResult> {
  const { name, blocksDir } = opts;
  const registryUrl = opts.registryUrl ?? DEFAULT_REGISTRY_URL;
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike);

  if (!ITEM_NAME_RE.test(name)) {
    throw new Error(
      `Invalid item name "${name}" — only letters, digits, "-" and "_" are allowed.`,
    );
  }

  const index = await fetchRegistryIndex(registryUrl, fetchImpl);
  const entry = index.find((i) => i.name === name);
  if (!entry) {
    throw new Error(
      `Item "${name}" not found in the registry.\nBrowse available items with: argo add --list`,
    );
  }

  const kind = kindFromType(entry.type);
  if (!kind) {
    throw new Error(
      `"${name}" is a registry example and examples are not installable via argo add. ` +
        `Use the hyperframes CLI (hyperframes init --example ${name}) instead.`,
    );
  }

  const item = await fetchRegistryItem(registryUrl, kind, name, fetchImpl);
  for (const f of item.files) {
    if (!ITEM_FILE_RE.test(f.path)) {
      throw new Error(`Unsafe file path in registry-item.json for "${name}": "${f.path}"`);
    }
  }

  const targetDir = join(blocksDir, name);
  mkdirSync(targetDir, { recursive: true });

  const written: string[] = [];
  for (const f of item.files) {
    const content = await fetchItemFile(registryUrl, kind, name, f.path, fetchImpl);
    writeFileSync(join(targetDir, f.path), content, 'utf-8');
    written.push(f.path);
  }
  writeFileSync(join(targetDir, 'registry-item.json'), JSON.stringify(item, null, 2), 'utf-8');

  return { name, kind, files: written, targetDir };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/hf/add.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/hf/add.ts tests/hf/add.test.ts
git -c commit.gpgsign=false commit -m "feat(hf): installItem/listItems with path-traversal guards"
```

---

### Task 3: Config fields + `argo add` CLI command

**Files:**
- Modify: `src/config.ts` (ArgoConfig at :232, DEFAULTS at :253, and `defineConfig`)
- Modify: `src/cli.ts` (new command; place it after the existing `validate` command block that ends near :372)
- Test: `tests/hf/config-blocks.test.ts`

**Interfaces:**
- Consumes: `installItem`, `listItems` (Task 2).
- Produces: `ArgoConfig.blocksDir: string` (default `'blocks'`), `ArgoConfig.registry?: { url?: string }`. Tasks 5–7 read `config.blocksDir`; the CLI command exists end-to-end.

- [ ] **Step 1: Write the failing test**

Create `tests/hf/config-blocks.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { defineConfig } from '../../src/config.js';

describe('blocksDir / registry config', () => {
  it('defaults blocksDir to "blocks"', () => {
    expect(defineConfig({}).blocksDir).toBe('blocks');
  });

  it('honors a custom blocksDir', () => {
    expect(defineConfig({ blocksDir: 'assets/hf' }).blocksDir).toBe('assets/hf');
  });

  it('passes registry.url through and defaults registry to undefined', () => {
    expect(defineConfig({}).registry).toBeUndefined();
    expect(defineConfig({ registry: { url: 'https://x.test/reg' } }).registry?.url).toBe(
      'https://x.test/reg',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/hf/config-blocks.test.ts`
Expected: FAIL — `blocksDir`/`registry` not on `ArgoConfig` (TS) / undefined at runtime.

- [ ] **Step 3: Implement config fields**

In `src/config.ts`:

**3a.** Add to `interface ArgoConfig` (line ~232, after `outputDir: string;`):

```typescript
  /** Directory where `argo add` installs hyperframes registry items. Default 'blocks'. */
  blocksDir: string;
  /** Registry override for `argo add`. Defaults to the hyperframes GitHub registry. */
  registry?: { url?: string };
```

**3b.** Add to `DEFAULTS` (line ~253): `blocksDir: 'blocks',`

**3c.** In `defineConfig`, follow the exact pattern the function already uses for top-level fields like `demosDir`/`outputDir` (Read the function body first): ensure the returned object includes `blocksDir: userConfig.blocksDir ?? DEFAULTS.blocksDir` and `registry: userConfig.registry`. If `defineConfig` builds its result with a spread of `DEFAULTS` then `userConfig`, the default may already flow — verify with the test rather than assuming.

- [ ] **Step 4: Run config test to verify it passes**

Run: `npx vitest run tests/hf/config-blocks.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Add the CLI command**

In `src/cli.ts`, after the `validate` command registration block, add:

```typescript
  program
    .command('add [name]')
    .description('Install a block or component from the hyperframes registry into blocksDir')
    .option('--list', 'list available registry items instead of installing')
    .option('--json', 'machine-readable output')
    .option('--registry <url>', 'override the registry URL')
    .action(async (name: string | undefined, cmdOpts: { list?: boolean; json?: boolean; registry?: string }) => {
      const { installItem, listItems } = await import('./hf/add.js');
      const config = await loadConfig();
      const registryUrl = cmdOpts.registry ?? config.registry?.url;

      if (cmdOpts.list) {
        const items = await listItems({ registryUrl });
        if (cmdOpts.json) {
          console.log(JSON.stringify(items, null, 2));
        } else {
          for (const item of items) {
            console.log(`${item.type.replace('hyperframes:', '').padEnd(10)} ${item.name}`);
          }
          console.log(`\n${items.length} items. Install with: argo add <name>`);
        }
        return;
      }

      if (!name) {
        console.error('Usage: argo add <name>  (or argo add --list)');
        process.exitCode = 1;
        return;
      }

      try {
        const result = await installItem({ name, blocksDir: config.blocksDir, registryUrl });
        if (cmdOpts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Installed ${result.kind === 'components' ? 'component' : 'block'} "${result.name}" → ${result.targetDir}/`);
          for (const f of result.files) console.log(`  ${f}`);
          if (result.kind === 'components') {
            console.log(`\nUse it in a scene: "overlay": { "type": "hf-component", "name": "${result.name}" }`);
            console.log(`Or in a demo script: await applyComponent(page, '${result.name}')`);
          }
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });
```

Match the surrounding file's conventions for how `loadConfig` is called in other commands (Read a neighboring command's action first — e.g. `validate` — and mirror its config-loading call exactly, including any arguments it passes).

- [ ] **Step 6: Build + verify the command wires up**

Run: `npm run build && node bin/argo.js add --help`
Expected: build exit 0; help text shows `--list`, `--json`, `--registry`.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/cli.ts tests/hf/config-blocks.test.ts
git -c commit.gpgsign=false commit -m "feat(cli): argo add command + blocksDir/registry config"
```

---

### Task 4: Component snippet parser + param safety

**Files:**
- Create: `src/hf/component.ts`
- Test: `tests/hf/component.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (Task 5 depends on): `interface ComponentSnippet { html: string; css: string; js: string }`, `parseComponentSnippet(source: string): ComponentSnippet`, `isSafeCssValue(v: string): boolean`, `isSafeCssVarName(k: string): boolean`.

- [ ] **Step 1: Write the failing test**

Create `tests/hf/component.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseComponentSnippet, isSafeCssValue, isSafeCssVarName } from '../../src/hf/component.js';

const VIGNETTE_LIKE = `<!--
  Vignette — usage notes here.
-->
<div id="hf-vignette" style="position: absolute; inset: 0; pointer-events: none;"></div>
<style>
  #hf-vignette { background: radial-gradient(ellipse at center, transparent 45%, rgba(0,0,0,0.7) 100%); }
</style>
<!-- Timeline integration example: tl.fromTo("#hf-vignette", ...) -->`;

const SHIMMER_LIKE = `<style>
  .shimmer-sweep-target { position: relative; }
</style>
<script>
  (function () { document.querySelectorAll(".shimmer-sweep-target").forEach(() => {}); })();
</script>`;

describe('parseComponentSnippet', () => {
  it('splits a root-element component into html + css, stripping comments', () => {
    const s = parseComponentSnippet(VIGNETTE_LIKE);
    expect(s.html).toContain('hf-vignette');
    expect(s.html).not.toContain('<style');
    expect(s.html).not.toContain('Timeline integration');
    expect(s.css).toContain('radial-gradient');
    expect(s.js).toBe('');
  });

  it('extracts scripts from style+script components (no root element)', () => {
    const s = parseComponentSnippet(SHIMMER_LIKE);
    expect(s.html).toBe('');
    expect(s.css).toContain('.shimmer-sweep-target');
    expect(s.js).toContain('querySelectorAll');
  });
});

describe('param safety', () => {
  it('accepts normal CSS values', () => {
    for (const ok of ['rgba(0, 0, 0, 0.7)', '45%', '120deg', '#ff8800', 'ellipse', '2.5s']) {
      expect(isSafeCssValue(ok), ok).toBe(true);
    }
  });

  it('rejects values that could escape a declaration or load resources', () => {
    for (const bad of [
      'red; background: blue',
      '} body { display: none',
      'url(https://evil.test/x)',
      'expression(alert(1))',
      '<script>',
      'javascript:alert(1)',
      '@import "x"',
    ]) {
      expect(isSafeCssValue(bad), bad).toBe(false);
    }
  });

  it('validates custom property names', () => {
    expect(isSafeCssVarName('--vignette-size')).toBe(true);
    expect(isSafeCssVarName('--x')).toBe(true);
    expect(isSafeCssVarName('color')).toBe(false);
    expect(isSafeCssVarName('--bad;inject')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/hf/component.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/hf/component.ts`:

```typescript
/**
 * Parse a hyperframes component snippet (HTML + <style> + optional <script>,
 * with usage notes in HTML comments) into injectable parts.
 *
 * Components are trusted-at-install (the user chose to `argo add` them and
 * the files are git-reviewable), but cue/script `params` are runtime input —
 * they are validated before being set as CSS custom properties.
 */

export interface ComponentSnippet {
  html: string;
  css: string;
  js: string;
}

export function parseComponentSnippet(source: string): ComponentSnippet {
  const noComments = source.replace(/<!--[\s\S]*?-->/g, '');
  const css: string[] = [];
  const js: string[] = [];
  let rest = noComments.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_m, body: string) => {
    css.push(body.trim());
    return '';
  });
  rest = rest.replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, (_m, body: string) => {
    js.push(body.trim());
    return '';
  });
  return { html: rest.trim(), css: css.join('\n\n'), js: js.join('\n\n') };
}

/** CSS custom property name: --kebab-or-camel, nothing else. */
export function isSafeCssVarName(k: string): boolean {
  return /^--[a-zA-Z][a-zA-Z0-9-]*$/.test(k);
}

/**
 * Conservative allowlist-by-rejection for CSS custom property VALUES.
 * Blocks declaration/block escapes and resource loads. Values are plain
 * lengths, colors, keywords, and simple functions like rgba()/calc().
 */
export function isSafeCssValue(v: string): boolean {
  if (typeof v !== 'string' || v.length === 0 || v.length > 200) return false;
  if (/[;{}<>]/.test(v)) return false;
  if (/url\s*\(|expression\s*\(|@import|javascript:/i.test(v)) return false;
  // Reject raw control characters — never legitimate in a CSS value.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v)) return false;
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/hf/component.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/hf/component.ts tests/hf/component.test.ts
git -c commit.gpgsign=false commit -m "feat(hf): component snippet parser + CSS param safety checks"
```

---

### Task 5: `applyComponent` / `removeComponent` page injection

**Files:**
- Create: `src/hf/apply-component.ts`
- Modify: `src/index.ts` (add export line)
- Test: `tests/hf/apply-component.test.ts` (Playwright integration — the one allowed browser test)

**Interfaces:**
- Consumes: `parseComponentSnippet`, `isSafeCssValue`, `isSafeCssVarName` (Task 4).
- Produces (Task 6 depends on):
  - `resolveBlocksDir(explicit?: string): string` — `explicit ?? process.env.ARGO_BLOCKS_DIR ?? 'blocks'`
  - `applyComponent(page: Page, name: string, opts?: { params?: Record<string, string>; blocksDir?: string }): Promise<void>`
  - `removeComponent(page: Page, name: string): Promise<void>`

Injection contract (Task 6's cue dispatch and the docs rely on this): container `<div id="argo-hf-<name>">`, fixed full-viewport, `pointer-events: none`, `z-index: 2147482000`; component CSS in a `<style data-argo-hf="<name>">` in `<head>`; params set as CSS custom properties on BOTH the container and `document.documentElement` (components like shimmer-sweep target page elements outside the container); param keys recorded on `container.dataset.argoHfParams` so `removeComponent` can clean up the documentElement props; scripts run via `new Function(js)()` (CSP caveat: on apps with a strict `script-src` this throws — surface as a warning naming CSP, do not fail the demo).

- [ ] **Step 1: Write the failing test**

Create `tests/hf/apply-component.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type Browser, type Page } from 'playwright';
import { applyComponent, removeComponent, resolveBlocksDir } from '../../src/hf/apply-component.js';

const SNIPPET = `<div id="hf-vignette"></div>
<style>#hf-vignette { position: absolute; inset: 0; background: radial-gradient(ellipse, transparent var(--vignette-size, 45%), rgba(0,0,0,0.7) 100%); }</style>
<script>document.documentElement.dataset.hfScriptRan = '1';</script>`;

let browser: Browser;
let page: Page;
let tmp: string;

beforeAll(async () => {
  browser = await chromium.launch();
}, 60_000);
afterAll(async () => { await browser.close(); });

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'argo-apply-'));
  mkdirSync(join(tmp, 'vignette'), { recursive: true });
  writeFileSync(join(tmp, 'vignette', 'vignette.html'), SNIPPET);
  page = await browser.newPage();
  await page.setContent('<h1>app</h1>');
});
afterEach(async () => {
  await page.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('resolveBlocksDir', () => {
  it('prefers explicit, then env, then "blocks"', () => {
    const prev = process.env.ARGO_BLOCKS_DIR;
    delete process.env.ARGO_BLOCKS_DIR;
    expect(resolveBlocksDir('x')).toBe('x');
    expect(resolveBlocksDir()).toBe('blocks');
    process.env.ARGO_BLOCKS_DIR = '/tmp/bd';
    expect(resolveBlocksDir()).toBe('/tmp/bd');
    if (prev === undefined) delete process.env.ARGO_BLOCKS_DIR; else process.env.ARGO_BLOCKS_DIR = prev;
  });
});

describe('applyComponent / removeComponent', () => {
  it('injects container + style + runs script, applies params, and removes cleanly', async () => {
    await applyComponent(page, 'vignette', {
      blocksDir: tmp,
      params: { '--vignette-size': '30%' },
    });

    expect(await page.locator('#argo-hf-vignette').count()).toBe(1);
    expect(await page.locator('style[data-argo-hf="vignette"]').count()).toBe(1);
    expect(await page.evaluate(() => document.documentElement.dataset.hfScriptRan)).toBe('1');
    expect(
      await page.evaluate(() =>
        document.documentElement.style.getPropertyValue('--vignette-size'),
      ),
    ).toBe('30%');

    await removeComponent(page, 'vignette');
    expect(await page.locator('#argo-hf-vignette').count()).toBe(0);
    expect(await page.locator('style[data-argo-hf="vignette"]').count()).toBe(0);
    expect(
      await page.evaluate(() =>
        document.documentElement.style.getPropertyValue('--vignette-size'),
      ),
    ).toBe('');
  });

  it('throws for a component that is not installed', async () => {
    await expect(applyComponent(page, 'nope', { blocksDir: tmp })).rejects.toThrow(/argo add nope/);
  });

  it('rejects unsafe params before touching the page', async () => {
    await expect(
      applyComponent(page, 'vignette', { blocksDir: tmp, params: { '--x': 'red; }' } }),
    ).rejects.toThrow(/unsafe/i);
    await expect(
      applyComponent(page, 'vignette', { blocksDir: tmp, params: { 'not-a-var': 'red' } }),
    ).rejects.toThrow(/custom property/i);
  });
}, 60_000);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/hf/apply-component.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

First Read the top of `src/effects.ts` to copy its `Page` import style and its disposal-error filter helper exactly (the catch block that swallows only page/context-closed errors and warns on everything else). Then create `src/hf/apply-component.ts`:

```typescript
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { isSafeCssValue, isSafeCssVarName, parseComponentSnippet } from './component.js';

const ITEM_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const CONTAINER_PREFIX = 'argo-hf-';

export function resolveBlocksDir(explicit?: string): string {
  return explicit ?? process.env.ARGO_BLOCKS_DIR ?? 'blocks';
}

export interface ApplyComponentOptions {
  /** CSS custom property overrides, e.g. { '--vignette-size': '40%' }. */
  params?: Record<string, string>;
  /** Override the blocks directory (defaults to ARGO_BLOCKS_DIR or 'blocks'). */
  blocksDir?: string;
}

/**
 * Inject an installed hyperframes component (full-frame, pointer-events:
 * none) into the recorded page. Persists until removeComponent() — pair
 * them, or use the `hf-component` overlay cue for duration-based display.
 */
export async function applyComponent(
  page: Page,
  name: string,
  opts?: ApplyComponentOptions,
): Promise<void> {
  if (!ITEM_NAME_RE.test(name)) {
    throw new Error(`Invalid component name "${name}"`);
  }
  const dir = resolveBlocksDir(opts?.blocksDir);
  const file = join(dir, name, `${name}.html`);
  if (!existsSync(file)) {
    throw new Error(`Component "${name}" is not installed (looked in ${dir}/). Run: argo add ${name}`);
  }
  const snippet = parseComponentSnippet(readFileSync(file, 'utf-8'));

  const params = opts?.params ?? {};
  for (const [k, v] of Object.entries(params)) {
    if (!isSafeCssVarName(k)) {
      throw new Error(`Param "${k}" is not a CSS custom property name (must match --kebab-case)`);
    }
    if (!isSafeCssValue(v)) {
      throw new Error(`Unsafe CSS value for param "${k}": ${JSON.stringify(v)}`);
    }
  }

  // Render fence — flush pending browser renders before injecting (same
  // rationale as overlay injection; see src/overlays/zones.ts).
  await page.evaluate(() => {});
  await page.evaluate(
    ({ name, html, css, js, params, prefix }) => {
      const id = prefix + name;
      document.getElementById(id)?.remove();
      document.querySelectorAll(`style[data-argo-hf="${name}"]`).forEach((el) => el.remove());

      if (css) {
        const st = document.createElement('style');
        st.setAttribute('data-argo-hf', name);
        st.textContent = css;
        document.head.appendChild(st);
      }

      const container = document.createElement('div');
      container.id = id;
      container.style.cssText =
        'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147482000';
      for (const [k, v] of Object.entries(params)) {
        container.style.setProperty(k, v);
        document.documentElement.style.setProperty(k, v);
      }
      container.dataset.argoHfParams = JSON.stringify(Object.keys(params));
      if (html) container.innerHTML = html;
      document.body.appendChild(container);

      if (js) {
        try {
          new Function(js)();
        } catch (e) {
          console.warn(
            `[argo] component "${name}" script failed (strict CSP can block injected scripts): ${String(e)}`,
          );
        }
      }
    },
    { name, html: snippet.html, css: snippet.css, js: snippet.js, params, prefix: CONTAINER_PREFIX },
  );
}

/** Remove an applied component and its params/styles. */
export async function removeComponent(page: Page, name: string): Promise<void> {
  if (!ITEM_NAME_RE.test(name)) return;
  await page.evaluate(
    ({ name, prefix }) => {
      const container = document.getElementById(prefix + name);
      if (container?.dataset.argoHfParams) {
        try {
          for (const k of JSON.parse(container.dataset.argoHfParams) as string[]) {
            document.documentElement.style.removeProperty(k);
          }
        } catch {
          /* ignore malformed dataset */
        }
      }
      container?.remove();
      document.querySelectorAll(`style[data-argo-hf="${name}"]`).forEach((el) => el.remove());
    },
    { name, prefix: CONTAINER_PREFIX },
  );
}
```

Then wrap the two `page.evaluate` bodies' outer calls in the same try/catch disposal-filter pattern `showConfetti` uses (swallow page/context-closed errors, `console.warn` everything else) — copy that catch block verbatim from `src/effects.ts` so the error-handling contract matches the rest of the effects API. Note: the param/name validation and the not-installed check must throw BEFORE the try/catch region (the test asserts they reject).

**Export:** add to `src/index.ts`, near the `showConfetti` export (line ~57):

```typescript
export {
  applyComponent,
  removeComponent,
  type ApplyComponentOptions,
} from './hf/apply-component.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/hf/apply-component.test.ts`
Expected: PASS (5 tests; launches chromium, ~5-15s)

- [ ] **Step 5: Commit**

```bash
git add src/hf/apply-component.ts src/index.ts tests/hf/apply-component.test.ts
git -c commit.gpgsign=false commit -m "feat(hf): applyComponent/removeComponent page injection"
```

---

### Task 6: `hf-component` overlay cue + env bridge

**Files:**
- Modify: `src/overlays/types.ts` (add cue interface; extend union at :101)
- Modify: `src/overlays/index.ts` (early dispatch in `showOverlay` at :90 and `withOverlay` at :159)
- Modify: `src/overlays/templates.ts` (`renderTemplate` switch — add throw case for exhaustiveness)
- Modify: `src/record.ts` (`RecordOptions` + env at :293)
- Modify: `src/pipeline.ts:172` block, `src/pipeline.ts:527` block, `src/cli.ts:93` block (add `blocksDir: config.blocksDir,` to each `record()` options object)
- Test: `tests/hf/hf-component-cue.test.ts`

**Interfaces:**
- Consumes: `applyComponent`, `removeComponent` (Task 5), `config.blocksDir` (Task 3).
- Produces: `HfComponentCue { type: 'hf-component'; name: string; params?: Record<string, string>; placement?: Zone }` in the `OverlayCue` union; `RecordOptions.blocksDir?: string`; `ARGO_BLOCKS_DIR` env in the Playwright subprocess. Task 7 validates the cue; Task 8 documents it.

- [ ] **Step 1: Write the failing test**

Create `tests/hf/hf-component-cue.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { OverlayCue } from '../../src/overlays/types.js';
import { showOverlay } from '../../src/overlays/index.js';
import { renderTemplate } from '../../src/overlays/templates.js';

describe('HfComponentCue', () => {
  it('is part of the OverlayCue union at compile time', () => {
    const cue: OverlayCue = { type: 'hf-component', name: 'vignette', params: { '--x': '1' } };
    expect(cue.type).toBe('hf-component');
  });

  it('renderTemplate rejects hf-component cues with a pointer to the right path', () => {
    expect(() => renderTemplate({ type: 'hf-component', name: 'vignette' })).toThrow(
      /full-frame/i,
    );
  });
});

describe('showOverlay dispatch for hf-component', () => {
  let tmp: string;
  let prevEnv: string | undefined;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'argo-cue-'));
    mkdirSync(join(tmp, 'vignette'), { recursive: true });
    writeFileSync(join(tmp, 'vignette', 'vignette.html'), '<div id="hf-vignette"></div>');
    prevEnv = process.env.ARGO_BLOCKS_DIR;
    process.env.ARGO_BLOCKS_DIR = tmp;
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env.ARGO_BLOCKS_DIR;
    else process.env.ARGO_BLOCKS_DIR = prevEnv;
  });

  it('applies, waits durationMs, and removes — never touching zone machinery', async () => {
    const calls: string[] = [];
    const fakePage = {
      evaluate: async () => { calls.push('evaluate'); },
      waitForTimeout: async (ms: number) => { calls.push(`wait:${ms}`); },
    };
    await showOverlay(
      fakePage as never,
      'intro',
      { type: 'hf-component', name: 'vignette' },
      1200,
    );
    // applyComponent issues 2 evaluates (fence + inject), removeComponent 1.
    expect(calls).toEqual(['evaluate', 'evaluate', 'wait:1200', 'evaluate']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/hf/hf-component-cue.test.ts`
Expected: FAIL — `'hf-component'` not assignable to `OverlayCue['type']` (TS via vitest transform runs, so runtime failures: renderTemplate falls through / dispatch missing → different call sequence).

- [ ] **Step 3: Implement**

**3a.** In `src/overlays/types.ts`, add before the union (line ~101):

```typescript
export interface HfComponentCue {
  type: 'hf-component';
  /** Installed component name under blocksDir (see `argo add`). */
  name: string;
  /** CSS custom property overrides, e.g. { '--vignette-size': '40%' }. */
  params?: Record<string, string>;
  /** Accepted for manifest uniformity but ignored — components are full-frame. */
  placement?: Zone;
}
```

and extend the union:

```typescript
export type OverlayCue = LowerThirdCue | HeadlineCardCue | CalloutCue | ImageCardCue | ArrowCue | CustomBlockCue | HfComponentCue;
```

(If `Zone` is not already imported in types.ts, mirror how `placement` is typed on the other cue interfaces in this file — use exactly that type.)

**3b.** In `src/overlays/index.ts`, import `applyComponent`/`removeComponent` from `../hf/apply-component.js`, then insert the early dispatch in `showOverlay` immediately after `cue`/`durationMs` are resolved (after the `if (typeof cueOrDuration === 'number') {...} else {...}` block, before the `const zone: Zone = ...` line):

```typescript
  if (cue.type === 'hf-component') {
    // Full-frame component — bypasses zone/theme/template machinery.
    await applyComponent(page, cue.name, { params: cue.params });
    await page.waitForTimeout(durationMs);
    await removeComponent(page, cue.name);
    return;
  }
```

In `withOverlay`, add the equivalent branch after its cue resolution (Read the function body first — it wraps a user action; apply before running the action, remove in the `finally`):

```typescript
  if (cue.type === 'hf-component') {
    await applyComponent(page, cue.name, { params: cue.params });
    try {
      return await action();
    } finally {
      await removeComponent(page, cue.name);
    }
  }
```

(Adjust the `action` identifier to the actual parameter name used in `withOverlay` — read it, don't guess.)

**3c.** In `src/overlays/templates.ts`, add to the `renderTemplate` switch before the closing brace:

```typescript
    case 'hf-component':
      throw new Error(
        'hf-component cues are injected full-frame by showOverlay/applyComponent, not rendered as zone templates.',
      );
```

**3d.** In `src/record.ts`: add to `RecordOptions` (line ~9 block): `blocksDir?: string;` — then in the env object (line ~293, next to `ARGO_OVERLAYS_PATH`):

```typescript
          ARGO_BLOCKS_DIR: path.resolve(options.blocksDir ?? 'blocks'),
```

**3e.** Add `blocksDir: config.blocksDir,` to the `record()` options objects at `src/pipeline.ts:172` block, `src/pipeline.ts:527` block, and `src/cli.ts:93` block (all three list `demosDir: config.demosDir,` first — add the new line right after it).

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run tests/hf/hf-component-cue.test.ts && npx vitest run tests/overlays/ && npm run build`
Expected: new tests PASS; existing overlay tests still PASS; build exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/overlays/types.ts src/overlays/index.ts src/overlays/templates.ts src/record.ts src/pipeline.ts src/cli.ts tests/hf/hf-component-cue.test.ts
git -c commit.gpgsign=false commit -m "feat(overlays): hf-component cue + ARGO_BLOCKS_DIR env bridge"
```

---

### Task 7: `argo validate` — hf-component names + accent hex

**Files:**
- Modify: `src/validate.ts` (validTypes at :59; overlay checks at :73-100; `ValidateOptions` at the top)
- Modify: `src/cli.ts` (validate command action — pass the two new options; Read the existing call to see how options are passed)
- Test: extend the existing validate test file (find it: `ls tests/ | grep -i validate`; if none exists, create `tests/hf/validate-hf.test.ts` using `validateDemo` directly with a temp demos dir — mirror how other tests build fixture manifests, e.g. the preview tests create temp `.scenes.json` files)

**Interfaces:**
- Consumes: `HfComponentCue` shape (Task 6), `config.blocksDir` (Task 3), the accent regex contract from Track 1 (`/^#?[0-9a-fA-F]{6}$/`).
- Produces: `ValidateOptions.blocksDir?: string` (default `'blocks'`) and `ValidateOptions.transitionAccent?: string`; two new error classes in validate output.

- [ ] **Step 1: Write the failing tests**

Add tests (in the located/created test file) covering exactly these behaviors:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateDemo } from '../../src/validate.js';

describe('validate: hf-component + accent', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'argo-validate-hf-'));
    mkdirSync(join(tmp, 'demos'), { recursive: true });
    mkdirSync(join(tmp, 'blocks', 'vignette'), { recursive: true });
    writeFileSync(join(tmp, 'blocks', 'vignette', 'vignette.html'), '<div></div>');
    writeFileSync(
      join(tmp, 'demos', 'd.demo.ts'),
      `import { test } from '@argo-video/cli';\ntest('d', async ({ page, narration }) => { narration.mark('intro'); });\n`,
    );
  });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  function writeManifest(overlay: unknown) {
    writeFileSync(
      join(tmp, 'demos', 'd.scenes.json'),
      JSON.stringify({ scenes: [{ scene: 'intro', text: 'hi', overlay }] }),
    );
  }

  it('accepts an installed hf-component', async () => {
    writeManifest({ type: 'hf-component', name: 'vignette' });
    const result = await validateDemo({ demo: 'd', demosDir: join(tmp, 'demos'), blocksDir: join(tmp, 'blocks') });
    expect(result.errors.filter((e) => e.includes('hf-component'))).toEqual([]);
  });

  it('errors on a missing hf-component with an install hint', async () => {
    writeManifest({ type: 'hf-component', name: 'grain-overlay' });
    const result = await validateDemo({ demo: 'd', demosDir: join(tmp, 'demos'), blocksDir: join(tmp, 'blocks') });
    expect(result.errors.some((e) => /grain-overlay.*argo add/.test(e))).toBe(true);
  });

  it('errors on an hf-component cue missing "name"', async () => {
    writeManifest({ type: 'hf-component' });
    const result = await validateDemo({ demo: 'd', demosDir: join(tmp, 'demos'), blocksDir: join(tmp, 'blocks') });
    expect(result.errors.some((e) => /hf-component.*name/i.test(e))).toBe(true);
  });

  it('errors on a malformed transition accent', async () => {
    writeManifest(undefined);
    const result = await validateDemo({
      demo: 'd', demosDir: join(tmp, 'demos'), blocksDir: join(tmp, 'blocks'), transitionAccent: 'blue',
    });
    expect(result.errors.some((e) => /accent.*hex/i.test(e))).toBe(true);
  });

  it('accepts a valid transition accent', async () => {
    writeManifest(undefined);
    const result = await validateDemo({
      demo: 'd', demosDir: join(tmp, 'demos'), blocksDir: join(tmp, 'blocks'), transitionAccent: '#0EA5E9',
    });
    expect(result.errors.filter((e) => /accent/i.test(e))).toEqual([]);
  });
});
```

IMPORTANT: before finalizing these tests, Read `src/validate.ts:1-60` and one existing validate test to confirm `ValidateOptions`'s actual field names for demo/demosDir (adjust the option keys in the tests above to the real interface — the shape shown here is the expected addition, not a license to rename existing fields) and to confirm what a minimal passing fixture requires (the demo script scene-name cross-check may need the manifest and script scenes to agree, as in the fixture above).

- [ ] **Step 2: Run to verify failures** — the hf-component manifests currently produce `unknown type "hf-component"` errors and `blocksDir`/`transitionAccent` are not accepted options (TS error at build; vitest runs untyped so expect assertion failures).

- [ ] **Step 3: Implement in `src/validate.ts`**

**3a.** Add to `ValidateOptions`: 

```typescript
  /** Directory holding installed hyperframes items (config.blocksDir). Default 'blocks'. */
  blocksDir?: string;
  /** Mirrors config `export.transition.accent` — validated as 6-digit hex when set. */
  transitionAccent?: string;
```

**3b.** At `:59`, add `'hf-component'` to `validTypes`.

**3c.** After the block-specific validation (`if (ov.type === 'block') {...}` region), add:

```typescript
            // Validate hf-component-specific fields
            if (ov.type === 'hf-component') {
              if (!ov.name || typeof ov.name !== 'string') {
                errors.push(`Scene "${entry.scene}" overlay: hf-component requires a "name" field`);
              } else {
                const blocksDir = options.blocksDir ?? 'blocks';
                const componentFile = path.join(blocksDir, ov.name, `${ov.name}.html`);
                if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(ov.name)) {
                  errors.push(`Scene "${entry.scene}" overlay: invalid hf-component name "${ov.name}"`);
                } else if (!existsSync(componentFile)) {
                  errors.push(
                    `Scene "${entry.scene}" overlay: hf-component "${ov.name}" is not installed ` +
                      `(missing ${componentFile}). Run: argo add ${ov.name}`,
                  );
                }
              }
            }
```

(Use whatever fs/path import style validate.ts already has — Read its imports and extend them rather than adding duplicate imports.)

**3d.** Add the accent check once, near the top of the validation flow (not per-scene):

```typescript
    if (options.transitionAccent !== undefined && !/^#?[0-9a-fA-F]{6}$/.test(options.transitionAccent.trim())) {
      errors.push(
        `export.transition.accent: "${options.transitionAccent}" is not a 6-digit hex color (e.g. #0ea5e9)`,
      );
    }
```

**3e.** In `src/cli.ts`'s validate command action, pass the new options from config: `blocksDir: config.blocksDir` and `transitionAccent: config.export.transition?.type === 'shader' ? config.export.transition.accent : undefined` (match how the action already reads `config` — Read it first; if the transition config type needs narrowing, mirror how other CLI code narrows `config.export.transition`).

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run tests/hf/ && npm test && npm run build`
Expected: all green (the full suite guards the validate changes against regressions in existing validate tests).

- [ ] **Step 5: Commit**

```bash
git add src/validate.ts src/cli.ts tests/
git -c commit.gpgsign=false commit -m "feat(validate): hf-component install checks + transition accent hex validation"
```

---

### Task 8: Docs sync + end-to-end network smoke

**Files:**
- Modify: `README.md` (new "Catalog: argo add" section; config reference gains `blocksDir` + `registry.url`; overlay cue types list gains `hf-component`; script API list gains `applyComponent`/`removeComponent`)
- Modify: `CLAUDE.md` (new `### HyperFrames Catalog (src/hf/)` subsection under Architecture; env var list gains `ARGO_BLOCKS_DIR`; CLI section gains `argo add`)
- Modify: `skills/argo-guide/` (SKILL.md + references — grep for where overlay types and CLI commands are enumerated)

**Interfaces:** consumes everything; produces nothing downstream — closes Track 2.

- [ ] **Step 1: Update README** — document, minimally: `argo add <name>` / `argo add --list`; the install location (`blocks/<name>/`, git-tracked); the `hf-component` cue with a manifest example:

```json
{ "scene": "intro", "text": "…", "overlay": { "type": "hf-component", "name": "vignette", "params": { "--vignette-size": "40%" } } }
```

and the script API:

```ts
import { applyComponent, removeComponent } from '@argo-video/cli';
await applyComponent(page, 'grain-overlay');   // persists until removed
await removeComponent(page, 'grain-overlay');
```

Note the two caveats: caption-* components install but need word-timing support (future), and injected component scripts can be blocked by strict CSP (warning, not failure).

- [ ] **Step 2: Update CLAUDE.md and the argo-guide skill** per the Files list. CLAUDE.md's "Env Vars Bridging Config to Playwright" section gains: `ARGO_BLOCKS_DIR — blocks directory for installed hyperframes items (loaded by applyComponent/hf-component cues)`.

- [ ] **Step 3: Full verification + network smoke**

Run: `npm run build && npm test`
Expected: all green.

Then the one allowed network smoke (requires internet; if offline, report DONE_WITH_CONCERNS naming this step):

```bash
cd "$(mktemp -d)" && node /Users/shreyas/work/rnd/argo/bin/argo.js add --list | head -5 && node /Users/shreyas/work/rnd/argo/bin/argo.js add vignette && test -f blocks/vignette/vignette.html && echo SMOKE-OK
```

Expected: item list prints; `SMOKE-OK`.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md skills/
git -c commit.gpgsign=false commit -m "docs: argo add command, hf-component cue, blocksDir config"
```

---

## Self-Review Notes

- **Spec coverage:** command + --list/--json (T3), registry URL config (T3), native-format storage + traversal guards (T2), component adapter with injection fence + instance cleanup (T5), cue + `applyComponent` script API (T5/T6), `ARGO_BLOCKS_DIR` at record.ts with all THREE call sites (T6 — the spec said "both pipeline call sites"; recon found `argo record` in cli.ts:93 is a third `record()` caller, included), validate checks (T7), caption deferral (constraint + README caveat), trust model + param validation (T4/T5), Track-1-deferred accent validation folded into T7.
- **Placeholder scan:** steps that depend on unread code (defineConfig body, withOverlay param name, validate option names, effects.ts catch block) explicitly instruct Read-then-mirror with the target named — bounded lookups, not open TBDs.
- **Type consistency:** `FetchLike`/`RegistryIndexItem`/`InstallResult` names match across T1→T3; `resolveBlocksDir`/`applyComponent`/`removeComponent` match T5→T6; `blocksDir`/`transitionAccent` option names match T7's tests and impl; evaluate-call count in T6's fake-page test (fence + inject + remove = 3 evaluates) matches T5's implementation.
