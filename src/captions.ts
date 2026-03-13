import type { Page } from '@playwright/test';
import { showOverlay, hideOverlay, withOverlay } from './overlays/index.js';

/**
 * Show a lower-third caption for `durationMs`, then remove it.
 * @deprecated Use showOverlay() for new code.
 */
export async function showCaption(
  page: Page,
  scene: string,
  text: string,
  durationMs: number,
): Promise<void> {
  await showOverlay(page, scene, { type: 'lower-third', text }, durationMs);
}

/**
 * Remove the caption overlay.
 * @deprecated Use hideOverlay() for new code.
 */
export async function hideCaption(page: Page): Promise<void> {
  await hideOverlay(page, 'bottom-center');
}

/**
 * Show a caption while running `action`, then hide it (even on error).
 * @deprecated Use withOverlay() for new code.
 */
export async function withCaption(
  page: Page,
  scene: string,
  text: string,
  action: () => Promise<void>,
): Promise<void> {
  await withOverlay(page, scene, { type: 'lower-third', text }, action);
}
