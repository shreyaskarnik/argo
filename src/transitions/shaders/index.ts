import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadShader(name: string): string {
  const path = join(__dirname, `${name}.glsl`);
  return readFileSync(path, 'utf-8');
}

export const SHADER_NAMES = [
  'crosswarp', 'swirl', 'ripple', 'luma-mask', 'light-leak',
  'domain-warp', 'ridged-burn', 'thermal-distortion', 'swirl-vortex',
  'whip-pan', 'gravitational-lens', 'cinematic-zoom', 'chromatic-split', 'flash-through-white',
  'sdf-iris', 'ripple-waves',
] as const;
export type ShaderName = (typeof SHADER_NAMES)[number];

export const SHADERS: Record<ShaderName, string> = Object.fromEntries(
  SHADER_NAMES.map((name) => [name, loadShader(name)]),
) as Record<ShaderName, string>;

export function isValidShaderName(name: string): name is ShaderName {
  return (SHADER_NAMES as readonly string[]).includes(name);
}
