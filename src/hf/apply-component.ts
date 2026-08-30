import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
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
 * none) into the recorded page. Persists until removeComponent() - pair
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

  try {
    // Render fence - flush pending browser renders before injecting (same
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
  } catch (err) {
    // Swallow page/context disposal errors so fire-and-forget callers
    // never see an unhandled rejection. Surface anything else.
    const msg = (err as Error)?.message ?? '';
    if (!msg.includes('Target closed') && !msg.includes('destroyed') && !msg.includes('closed') && !msg.includes('disposed')) {
      console.warn(`Warning: component "${name}" injection failed: ${msg}`);
    }
  }
}

/** Remove an applied component and its params/styles. */
export async function removeComponent(page: Page, name: string): Promise<void> {
  if (!ITEM_NAME_RE.test(name)) return;
  try {
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
  } catch (err) {
    // Swallow page/context disposal errors so fire-and-forget callers
    // never see an unhandled rejection. Surface anything else.
    const msg = (err as Error)?.message ?? '';
    if (!msg.includes('Target closed') && !msg.includes('destroyed') && !msg.includes('closed') && !msg.includes('disposed')) {
      console.warn(`Warning: component "${name}" removal failed: ${msg}`);
    }
  }
}
