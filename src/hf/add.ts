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
