import type { Page } from '@playwright/test';
import type { OverlayCue, Zone } from './types.js';
import { injectIntoZone, removeZone, ZONE_ID_PREFIX, detectBackgroundTheme } from './zones.js';
import type { BackgroundTheme } from './zones.js';
import { renderTemplate } from './templates.js';
import { getMotionCSS, getMotionStyles } from './motion.js';

export type { OverlayCue, OverlayManifestEntry, Zone, TemplateType, MotionPreset } from './types.js';
export { renderTemplate } from './templates.js';
export type { BackgroundTheme } from './zones.js';

function getConfigAutoBackground(): boolean {
  return process.env.ARGO_AUTO_BACKGROUND === '1';
}

async function resolveTheme(
  page: Page,
  cue: OverlayCue,
  zone: Zone,
  optionsAutoBackground?: boolean,
): Promise<BackgroundTheme> {
  const shouldDetect = cue.autoBackground ?? optionsAutoBackground ?? getConfigAutoBackground();
  if (!shouldDetect) return 'dark';
  return detectBackgroundTheme(page, zone);
}

export async function showOverlay(
  page: Page,
  _scene: string,
  cue: OverlayCue,
  durationMs: number,
  options?: { autoBackground?: boolean },
): Promise<void> {
  const zone: Zone = cue.placement ?? 'bottom-center';
  const motion = cue.motion ?? 'none';
  const theme = await resolveTheme(page, cue, zone, options?.autoBackground);
  const { contentHtml, styles } = renderTemplate(cue, theme);
  const zoneId = ZONE_ID_PREFIX + zone;
  const motionCSS = getMotionCSS(motion, zoneId);
  const motionStyles = getMotionStyles(motion, zoneId);

  await injectIntoZone(page, zone, contentHtml, { ...styles, ...motionStyles }, motionCSS);
  await page.waitForTimeout(durationMs);
  await removeZone(page, zone);
}

export async function hideOverlay(
  page: Page,
  zone: Zone = 'bottom-center',
): Promise<void> {
  await removeZone(page, zone);
}

export async function withOverlay(
  page: Page,
  _scene: string,
  cue: OverlayCue,
  action: () => Promise<void>,
  options?: { autoBackground?: boolean },
): Promise<void> {
  const zone: Zone = cue.placement ?? 'bottom-center';
  const motion = cue.motion ?? 'none';
  const theme = await resolveTheme(page, cue, zone, options?.autoBackground);
  const { contentHtml, styles } = renderTemplate(cue, theme);
  const zoneId = ZONE_ID_PREFIX + zone;
  const motionCSS = getMotionCSS(motion, zoneId);
  const motionStyles = getMotionStyles(motion, zoneId);

  await injectIntoZone(page, zone, contentHtml, { ...styles, ...motionStyles }, motionCSS);
  try {
    await action();
  } finally {
    await removeZone(page, zone);
  }
}
