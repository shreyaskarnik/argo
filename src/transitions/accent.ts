/** RGB triple with components normalized to [0, 1]. */
export type Vec3 = [number, number, number];

export interface AccentColors {
  accent: Vec3;
  accentDark: Vec3;
  accentBright: Vec3;
}

/** Default accent used when `export.transition.accent` is not configured. */
export const DEFAULT_ACCENT = '#0ea5e9';

/**
 * Parse a 6-digit hex color and derive the dark/bright variants the ported
 * hyperframes shaders expect (edge glow, burn tinting). Dark is a simple
 * luminance scale; bright mixes toward white.
 */
export function deriveAccentColors(hex: string = DEFAULT_ACCENT): AccentColors {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) {
    throw new Error(`Invalid accent color "${hex}" — expected a 6-digit hex like #0ea5e9`);
  }
  const n = parseInt(m[1], 16);
  const accent: Vec3 = [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
  const accentDark = accent.map((v) => v * 0.35) as Vec3;
  const accentBright = accent.map((v) => v + (1 - v) * 0.65) as Vec3;
  return { accent, accentDark, accentBright };
}
