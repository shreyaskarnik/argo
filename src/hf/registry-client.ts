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
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>;

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
  const url = `${registryUrl}/registry.json`;
  const raw = await fetchText(url, fetchImpl);
  let parsed: { items?: RegistryIndexItem[] };
  try {
    parsed = JSON.parse(raw) as { items?: RegistryIndexItem[] };
  } catch {
    throw new Error(`Malformed JSON from registry at ${url} — got non-JSON response`);
  }
  if (!Array.isArray(parsed.items)) {
    throw new Error(`Malformed registry index: expected an "items" array at ${url}`);
  }
  return parsed.items;
}

export async function fetchRegistryItem(
  registryUrl: string,
  kind: 'blocks' | 'components',
  name: string,
  fetchImpl: FetchLike = fetch,
): Promise<RegistryItem> {
  const url = `${registryUrl}/${kind}/${name}/registry-item.json`;
  const raw = await fetchText(url, fetchImpl);
  let item: RegistryItem;
  try {
    item = JSON.parse(raw) as RegistryItem;
  } catch {
    throw new Error(`Malformed JSON from registry at ${url} — got non-JSON response`);
  }
  if (!item.name || !Array.isArray(item.files)) {
    throw new Error(`Malformed registry-item.json for "${name}": missing name or files`);
  }
  return item;
}

/**
 * Fetch one item file as raw bytes. Items ship images, audio and fonts next to
 * their HTML, and decoding those as text replaces every invalid UTF-8 byte
 * with U+FFFD, so the install would succeed and leave the asset corrupt.
 */
export async function fetchItemFile(
  registryUrl: string,
  kind: 'blocks' | 'components',
  name: string,
  filePath: string,
  fetchImpl: FetchLike = fetch,
): Promise<Buffer> {
  const url = `${registryUrl}/${kind}/${name}/${filePath}`;
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`Registry fetch failed (${res.status}): ${url}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
