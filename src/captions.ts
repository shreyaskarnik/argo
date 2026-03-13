import type { Page } from '@playwright/test';

const OVERLAY_ID = 'argo-caption-overlay';

const INJECT_SCRIPT = `(args) => {
  const existing = document.getElementById(args.id);
  if (existing) existing.remove();
  const div = document.createElement('div');
  div.id = args.id;
  div.textContent = args.text;
  Object.assign(div.style, {
    position: 'fixed',
    bottom: '48px',
    left: '50%',
    transform: 'translateX(-50%)',
    background: 'rgba(0, 0, 0, 0.75)',
    color: '#fff',
    padding: '12px 24px',
    borderRadius: '8px',
    fontSize: '18px',
    fontFamily: 'system-ui, sans-serif',
    zIndex: '999999',
    pointerEvents: 'none',
    textAlign: 'center',
    maxWidth: '80vw',
  });
  document.body.appendChild(div);
}`;

const REMOVE_SCRIPT = `(id) => {
  const el = document.getElementById(id);
  if (el) el.remove();
}`;

/**
 * Inject a styled caption overlay, wait for `durationMs`, then remove it.
 */
export async function showCaption(
  page: Page,
  scene: string,
  text: string,
  durationMs: number,
): Promise<void> {
  await page.evaluate(INJECT_SCRIPT, { id: OVERLAY_ID, text, scene });
  await page.waitForTimeout(durationMs);
  await page.evaluate(REMOVE_SCRIPT, OVERLAY_ID);
}

/**
 * Remove the caption overlay if present.
 */
export async function hideCaption(page: Page): Promise<void> {
  await page.evaluate(REMOVE_SCRIPT, OVERLAY_ID);
}

/**
 * Show a caption while running `action`, then hide it (even on error).
 */
export async function withCaption(
  page: Page,
  scene: string,
  text: string,
  action: () => Promise<void>,
): Promise<void> {
  await page.evaluate(INJECT_SCRIPT, { id: OVERLAY_ID, text, scene });
  try {
    await action();
  } finally {
    await page.evaluate(REMOVE_SCRIPT, OVERLAY_ID);
  }
}
