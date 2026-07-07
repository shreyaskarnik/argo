export const ZONES = [
  'bottom-center',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'center',
] as const;

export type Zone = (typeof ZONES)[number];

export const TEMPLATE_TYPES = [
  'lower-third',
  'headline-card',
  'callout',
  'image-card',
  'arrow',
] as const;

export type TemplateType = (typeof TEMPLATE_TYPES)[number];

export const MOTIONS = ['none', 'fade-in', 'slide-in'] as const;

export type MotionPresetName = (typeof MOTIONS)[number];

import type { GsapMotion } from './gsap-motion.js';
export type { GsapMotion, GsapTween, GsapEase, GsapVars } from './gsap-motion.js';

/** Either a named preset (`'fade-in'`, `'slide-in'`) or a GSAP motion object. */
export type MotionPreset = MotionPresetName | GsapMotion;

export interface LowerThirdCue {
  type: 'lower-third';
  text: string;
  placement?: Zone;
  motion?: MotionPreset;
  autoBackground?: boolean;
}

export interface HeadlineCardCue {
  type: 'headline-card';
  title: string;
  kicker?: string;
  body?: string;
  placement?: Zone;
  motion?: MotionPreset;
  autoBackground?: boolean;
}

export interface CalloutCue {
  type: 'callout';
  text: string;
  placement?: Zone;
  motion?: MotionPreset;
  autoBackground?: boolean;
}

export interface ImageCardCue {
  type: 'image-card';
  src: string;
  title?: string;
  body?: string;
  placement?: Zone;
  motion?: MotionPreset;
  autoBackground?: boolean;
}

export const ARROW_DIRECTIONS = [
  'up', 'down', 'left', 'right',
  'up-left', 'up-right', 'down-left', 'down-right',
] as const;

export type ArrowDirection = (typeof ARROW_DIRECTIONS)[number];

export interface ArrowCue {
  type: 'arrow';
  /** Arrow direction. Default: 'down'. */
  direction?: ArrowDirection;
  /** Optional label text displayed alongside the arrow. */
  label?: string;
  /** Arrow color (CSS color value). Default: '#ef4444' (red). */
  color?: string;
  /** Arrow size in pixels. Default: 48. */
  size?: number;
  placement?: Zone;
  motion?: MotionPreset;
  autoBackground?: boolean;
}

export interface CustomBlockCue {
  type: 'block';
  /** Block id — must exist in BLOCK_REGISTRY. */
  block: string;
  /** Block-specific props. Shape is validated per-block at render time. */
  props: Record<string, unknown>;
  placement?: Zone;
  motion?: MotionPreset;
  autoBackground?: boolean;
}

export interface HfComponentCue {
  type: 'hf-component';
  /** Installed component name under blocksDir (see `argo add`). */
  name: string;
  /** CSS custom property overrides, e.g. { '--vignette-size': '40%' }. */
  params?: Record<string, string>;
  /** Accepted for manifest uniformity but ignored — components are full-frame. */
  placement?: Zone;
  /** Accepted for manifest uniformity but ignored — components are full-frame. */
  motion?: MotionPreset;
  /** Accepted for manifest uniformity but ignored — components are full-frame. */
  autoBackground?: boolean;
}

export type OverlayCue = LowerThirdCue | HeadlineCardCue | CalloutCue | ImageCardCue | ArrowCue | CustomBlockCue | HfComponentCue;

export type OverlayManifestEntry = OverlayCue & {
  scene: string;
};

// ─── Effects ──────────────────────────────────────────────────────────────

export const EFFECT_TYPES = ['confetti', 'spotlight', 'focus-ring', 'dim-around', 'zoom-to'] as const;

export type EffectType = (typeof EFFECT_TYPES)[number];

export const CONFETTI_SPREADS = ['burst', 'rain'] as const;

export type ConfettiSpread = (typeof CONFETTI_SPREADS)[number];

export interface ConfettiEffect {
  type: 'confetti';
  spread?: ConfettiSpread;
  duration?: number;
  pieces?: number;
}

export interface SpotlightEffect {
  type: 'spotlight';
  selector: string;
  duration?: number;
  padding?: number;
}

export interface FocusRingEffect {
  type: 'focus-ring';
  selector: string;
  color?: string;
  duration?: number;
}

export interface DimAroundEffect {
  type: 'dim-around';
  selector: string;
  duration?: number;
}

export interface ZoomToEffect {
  type: 'zoom-to';
  selector: string;
  scale?: number;
  duration?: number;
}

export type SceneEffect = ConfettiEffect | SpotlightEffect | FocusRingEffect | DimAroundEffect | ZoomToEffect;

export function isValidEffectType(value: string): value is EffectType {
  return (EFFECT_TYPES as readonly string[]).includes(value);
}

/** A single entry in the unified .scenes.json manifest. */
export interface SceneEntry {
  scene: string;
  /** Spoken narration text. Omit for silent scenes (no TTS). */
  text?: string;
  voice?: string;
  speed?: number;
  lang?: string;
  /** Playback speed multiplier for this scene's video segment (e.g., 0.5 = half speed, 2.0 = double speed).
   * Unlike `speed` (TTS speech rate), this controls the video playback speed during export.
   * Default: 1.0 (normal speed). */
  playbackSpeed?: number;
  _hint?: string;
  overlay?: OverlayCue;
  effects?: SceneEffect[];
}

export function isValidZone(value: string): value is Zone {
  return (ZONES as readonly string[]).includes(value);
}

export function isValidTemplateType(value: string): value is TemplateType {
  return (TEMPLATE_TYPES as readonly string[]).includes(value);
}

export function isValidMotion(value: unknown): value is MotionPreset {
  if (typeof value === 'string') {
    return (MOTIONS as readonly string[]).includes(value);
  }
  if (typeof value === 'object' && value !== null) {
    return (value as { type?: unknown }).type === 'gsap';
  }
  return false;
}

export function isValidMotionName(value: string): value is MotionPresetName {
  return (MOTIONS as readonly string[]).includes(value);
}
