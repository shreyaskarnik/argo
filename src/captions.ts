import type { Page } from '@playwright/test';

const OVERLAY_ID = 'argo-caption-overlay';

const CAPTION_STYLES = {
  position: 'fixed',
  bottom: '60px',
  left: '50%',
  transform: 'translateX(-50%)',
  background: 'rgba(0, 0, 0, 0.85)',
  color: '#fff',
  padding: '16px 32px',
  borderRadius: '12px',
  fontSize: '28px',
  fontWeight: '500',
  fontFamily: 'system-ui, -apple-system, sans-serif',
  zIndex: '999999',
  pointerEvents: 'none',
  textAlign: 'center',
  maxWidth: '80vw',
  letterSpacing: '0.01em',
  lineHeight: '1.4',
  boxShadow: '0 4px 24px rgba(0, 0, 0, 0.3)',
} as const;

async function injectOverlay(page: Page, text: string): Promise<void> {
  await page.evaluate(([id, txt, styles]) => {
    const existing = document.getElementById(id);
    if (existing) existing.remove();
    const div = document.createElement('div');
    div.id = id;
    div.textContent = txt;
    Object.assign(div.style, styles);
    document.body.appendChild(div);
  }, [OVERLAY_ID, text, CAPTION_STYLES] as const);
}

/**
 * Inject a styled caption overlay, wait for `durationMs`, then remove it.
 */
export async function showCaption(
  page: Page,
  _scene: string,
  text: string,
  durationMs: number,
): Promise<void> {
  await injectOverlay(page, text);
  await page.waitForTimeout(durationMs);
  await page.evaluate((id) => {
    document.getElementById(id)?.remove();
  }, OVERLAY_ID);
}

/**
 * Remove the caption overlay if present.
 */
export async function hideCaption(page: Page): Promise<void> {
  await page.evaluate((id) => {
    document.getElementById(id)?.remove();
  }, OVERLAY_ID);
}

/**
 * Show a caption while running `action`, then hide it (even on error).
 */
export async function withCaption(
  page: Page,
  _scene: string,
  text: string,
  action: () => Promise<void>,
): Promise<void> {
  await injectOverlay(page, text);
  try {
    await action();
  } finally {
    await page.evaluate((id) => {
      document.getElementById(id)?.remove();
    }, OVERLAY_ID);
  }
}
