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

export function isValidZone(value: string): value is Zone {
  return (ZONES as readonly string[]).includes(value);
}

export function isValidTemplateType(value: string): value is TemplateType {
  return (TEMPLATE_TYPES as readonly string[]).includes(value);
}

export function isValidMotion(value: string): value is MotionPreset {
  return (MOTIONS as readonly string[]).includes(value);
}
