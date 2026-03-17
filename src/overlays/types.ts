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
] as const;

export type TemplateType = (typeof TEMPLATE_TYPES)[number];

export const MOTIONS = ['none', 'fade-in', 'slide-in'] as const;

export type MotionPreset = (typeof MOTIONS)[number];

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

export type OverlayCue = LowerThirdCue | HeadlineCardCue | CalloutCue | ImageCardCue;

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

export function isValidMotion(value: string): value is MotionPreset {
  return (MOTIONS as readonly string[]).includes(value);
}
