import type { Page } from '@playwright/test';
import type { OverlayCue, Zone, MotionPreset } from './types.js';
import { injectIntoZone, removeZone, ZONE_ID_PREFIX, detectBackgroundTheme } from './zones.js';
import type { BackgroundTheme } from './zones.js';
import { renderTemplate } from './templates.js';
import { getMotionCSS, getMotionStyles } from './motion.js';
import { isGsapMotion } from './gsap-motion.js';
import { runGsapEntrance, runGsapExit, gsapExitWallMs } from './gsap-runtime.js';
import { loadOverlayFromManifest } from './manifest-loader.js';
import { getBlock, isValidBlockName } from '../blocks/index.js';
import { applyComponent, removeComponent } from '../hf/apply-component.js';

export type { OverlayCue, OverlayManifestEntry, Zone, TemplateType, MotionPreset } from './types.js';
export type { SceneEntry } from './types.js';
export type { GsapMotion, GsapTween, GsapEase, GsapVars } from './gsap-motion.js';
export { renderTemplate } from './templates.js';
export type { BackgroundTheme } from './zones.js';
export { resetManifestCache } from './manifest-loader.js';

function getConfigAutoBackground(): boolean {
  return process.env.ARGO_AUTO_BACKGROUND === '1';
}

function getConfigDefaultPlacement(): Zone | undefined {
  const val = process.env.ARGO_DEFAULT_PLACEMENT;
  if (val && ['bottom-center', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'].includes(val)) {
    return val as Zone;
  }
  return undefined;
}

export function isRawGsapAllowed(): boolean {
  return process.env.ARGO_ALLOW_RAW_GSAP === '1';
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

/**
 * Resolve the motion for a cue. Order of precedence:
 *   1. `cue.motion` (explicit on the cue)
 *   2. `block.defaultMotion` when the cue is a block cue
 *   3. `'none'`
 */
export function resolveMotion(cue: OverlayCue): MotionPreset {
  if (cue.motion !== undefined) return cue.motion;
  if (cue.type === 'block' && isValidBlockName(cue.block)) {
    const block = getBlock(cue.block);
    if (block.defaultMotion !== undefined) return block.defaultMotion;
  }
  return 'none';
}

export function resolveCue(scene: string, cueOrPartial?: OverlayCue | Partial<OverlayCue>): OverlayCue {
  const manifestCue = loadOverlayFromManifest(scene);
  if (cueOrPartial && 'type' in cueOrPartial && cueOrPartial.type) {
    // Full inline cue — merge with manifest if available
    return manifestCue ? { ...manifestCue, ...cueOrPartial } as OverlayCue : cueOrPartial as OverlayCue;
  }
  if (manifestCue) {
    // Manifest cue with optional overrides
    return cueOrPartial ? { ...manifestCue, ...cueOrPartial } as OverlayCue : manifestCue;
  }
  throw new Error(
    `No overlay found for scene "${scene}". ` +
    `Either add an overlay entry in your .scenes.json manifest, or pass an inline cue.`,
  );
}

// showOverlay overloads
export async function showOverlay(
  page: Page,
  scene: string,
  durationMs: number,
): Promise<void>;
export async function showOverlay(
  page: Page,
  scene: string,
  cue: OverlayCue | Partial<OverlayCue>,
  durationMs: number,
  options?: { autoBackground?: boolean },
): Promise<void>;
export async function showOverlay(
  page: Page,
  scene: string,
  cueOrDuration: OverlayCue | Partial<OverlayCue> | number,
  durationMsOrOptions?: number | { autoBackground?: boolean },
  options?: { autoBackground?: boolean },
): Promise<void> {
  let cue: OverlayCue;
  let durationMs: number;
  let opts: { autoBackground?: boolean } | undefined;

  if (typeof cueOrDuration === 'number') {
    // showOverlay(page, scene, durationMs)
    cue = resolveCue(scene);
    durationMs = cueOrDuration;
    opts = undefined;
  } else {
    // showOverlay(page, scene, cue, durationMs, options?)
    cue = resolveCue(scene, cueOrDuration);
    durationMs = durationMsOrOptions as number;
    opts = options;
  }

  if (cue.type === 'hf-component') {
    // Full-frame component — bypasses zone/theme/template machinery.
    await applyComponent(page, cue.name, { params: cue.params });
    await page.waitForTimeout(durationMs);
    await removeComponent(page, cue.name);
    return;
  }

  if (cue.type === 'hf-block') {
    // Export-time cutaway — nothing is injected during recording, but the
    // wait preserves the demo script's scene pacing.
    await page.waitForTimeout(durationMs);
    return;
  }

  const zone: Zone = cue.placement ?? getConfigDefaultPlacement() ?? 'bottom-center';
  const motion = resolveMotion(cue);
  const theme = await resolveTheme(page, cue, zone, opts?.autoBackground);
  const { contentHtml, styles } = renderTemplate(cue, theme);
  const zoneId = ZONE_ID_PREFIX + zone;
  const motionCSS = getMotionCSS(motion, zoneId);
  const motionStyles = getMotionStyles(motion, zoneId);

  // Tag this overlay instance so removeZone only removes it if it hasn't
  // been replaced by a newer overlay in the same zone (fire-and-forget safe).
  const instanceId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await injectIntoZone(page, zone, contentHtml, { ...styles, ...motionStyles }, motionCSS, instanceId);

  if (isGsapMotion(motion)) {
    await runGsapEntrance(page, zoneId, motion);
    const exitMs = gsapExitWallMs(motion);
    const holdMs = Math.max(0, durationMs - exitMs);
    await page.waitForTimeout(holdMs);
    if (motion.out) await runGsapExit(page, zoneId, motion);
  } else {
    await page.waitForTimeout(durationMs);
  }

  await removeZone(page, zone, instanceId);
}

export async function hideOverlay(
  page: Page,
  zone: Zone = 'bottom-center',
): Promise<void> {
  await removeZone(page, zone);
}

// withOverlay overloads
export async function withOverlay(
  page: Page,
  scene: string,
  action: () => Promise<void>,
): Promise<void>;
export async function withOverlay(
  page: Page,
  scene: string,
  cue: OverlayCue | Partial<OverlayCue>,
  action: () => Promise<void>,
  options?: { autoBackground?: boolean },
): Promise<void>;
export async function withOverlay(
  page: Page,
  scene: string,
  cueOrAction: OverlayCue | Partial<OverlayCue> | (() => Promise<void>),
  actionOrOptions?: (() => Promise<void>) | { autoBackground?: boolean },
  options?: { autoBackground?: boolean },
): Promise<void> {
  let cue: OverlayCue;
  let action: () => Promise<void>;
  let opts: { autoBackground?: boolean } | undefined;

  if (typeof cueOrAction === 'function') {
    // withOverlay(page, scene, action)
    cue = resolveCue(scene);
    action = cueOrAction;
    opts = undefined;
  } else {
    // withOverlay(page, scene, cue, action, options?)
    cue = resolveCue(scene, cueOrAction);
    action = actionOrOptions as () => Promise<void>;
    opts = options;
  }

  if (cue.type === 'hf-component') {
    await applyComponent(page, cue.name, { params: cue.params });
    try {
      return await action();
    } finally {
      await removeComponent(page, cue.name);
    }
  }

  if (cue.type === 'hf-block') {
    return await action();
  }

  const zone: Zone = cue.placement ?? getConfigDefaultPlacement() ?? 'bottom-center';
  const motion = resolveMotion(cue);
  const theme = await resolveTheme(page, cue, zone, opts?.autoBackground);
  const { contentHtml, styles } = renderTemplate(cue, theme);
  const zoneId = ZONE_ID_PREFIX + zone;
  const motionCSS = getMotionCSS(motion, zoneId);
  const motionStyles = getMotionStyles(motion, zoneId);

  const instanceId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await injectIntoZone(page, zone, contentHtml, { ...styles, ...motionStyles }, motionCSS, instanceId);
  if (isGsapMotion(motion)) {
    await runGsapEntrance(page, zoneId, motion);
  }
  try {
    await action();
  } finally {
    if (isGsapMotion(motion) && motion.out) {
      await runGsapExit(page, zoneId, motion);
    }
    await removeZone(page, zone, instanceId);
  }
}
