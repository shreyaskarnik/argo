import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import {
  DEFAULT_REGISTRY_URL,
  fetchItemFile,
  itemFileSourceUrl,
  fetchRegistryIndex,
  fetchRegistryItem,
  kindFromType,
  type FetchLike,
  type RegistryIndexItem,
} from './registry-client.js';

/** Same pattern the CLI uses for demo names — path-traversal guard. */
const ITEM_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/**
 * Whether `name` is a plain registry item name, safe to `path.join` onto
 * `blocksDir`. Shared with the render path so an installed item and a manifest
 * reference are held to the same rule.
 */
export function isValidItemName(name: string): boolean {
  return ITEM_NAME_RE.test(name);
}
/** One segment of an item file path — e.g. "vignette.html", "assets". */
const ITEM_FILE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Whether `filePath` is a safe relative path inside an item directory.
 *
 * Items keep assets in subdirectories (`assets/carousel-images/x.jpg`), so a
 * path may be nested, but every `/`-separated segment must be a plain name.
 * That rules out `..`, `.`, empty segments (absolute paths, `a//b`, trailing
 * `/`), dotfiles and backslashes in one rule, before anything touches disk.
 */
function isSafeItemFilePath(filePath: string): boolean {
  return filePath.split('/').every((segment) => ITEM_FILE_RE.test(segment));
}

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
    if (entry.type === 'hyperframes:example') {
      throw new Error(
        `"${name}" is a registry example and examples are not installable via argo add. ` +
          `Use the hyperframes CLI (hyperframes init --example ${name}) instead.`,
      );
    }
    throw new Error(`"${name}" has unsupported registry type "${entry.type}" — cannot install.`);
  }

  const item = await fetchRegistryItem(registryUrl, kind, name, fetchImpl);
  for (const f of item.files) {
    if (!isSafeItemFilePath(f.path)) {
      throw new Error(`Unsafe file path in registry-item.json for "${name}": "${f.path}"`);
    }
    // Validate every source up front too, so a bad url fails before any write.
    itemFileSourceUrl(registryUrl, kind, name, f);
  }

  const targetDir = join(blocksDir, name);
  mkdirSync(targetDir, { recursive: true });

  const written: string[] = [];
  for (const f of item.files) {
    const dest = resolve(targetDir, f.path);
    // Belt and braces for the segment check above: never write outside.
    if (!dest.startsWith(resolve(targetDir) + sep)) {
      throw new Error(`Unsafe file path in registry-item.json for "${name}": "${f.path}"`);
    }
    const content = await fetchItemFile(registryUrl, kind, name, f, fetchImpl);
    mkdirSync(dirname(dest), { recursive: true });
    // Bytes, not text: see fetchItemFile.
    writeFileSync(dest, content);
    written.push(f.path);
  }
  writeFileSync(join(targetDir, 'registry-item.json'), JSON.stringify(item, null, 2), 'utf-8');

  return { name, kind, files: written, targetDir };
}
