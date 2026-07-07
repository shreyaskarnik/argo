import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isGsapMotion, validateGsapMotion } from './overlays/gsap-motion.js';

export interface ValidateOptions {
  demoName: string;
  demosDir: string;
  /** Mirrors config `overlays.allowRawGsap`. When true, `motion.raw` is accepted. */
  allowRawGsap?: boolean;
  /** Directory holding installed hyperframes items (config.blocksDir). Default 'blocks'. */
  blocksDir?: string;
  /** Mirrors config `export.transition.accent` — validated as 6-digit hex when set. */
  transitionAccent?: string;
}

export interface ValidateResult {
  errors: string[];
  warnings: string[];
}

export async function validateDemo(options: ValidateOptions): Promise<ValidateResult> {
  const { demoName, demosDir } = options;
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate export.transition.accent (6-digit hex, optional leading #)
  if (options.transitionAccent !== undefined && !/^#?[0-9a-fA-F]{6}$/.test(options.transitionAccent.trim())) {
    errors.push(
      `export.transition.accent: "${options.transitionAccent}" is not a 6-digit hex color (e.g. #0ea5e9)`,
    );
  }

  // Check demo script exists
  const scriptPath = join(demosDir, `${demoName}.demo.ts`);
  if (!existsSync(scriptPath)) {
    errors.push(`Demo script not found: ${scriptPath}`);
    return { errors, warnings };
  }

  const scriptContent = readFileSync(scriptPath, 'utf-8');

  // Check import (single or double quotes)
  if (!scriptContent.includes("@argo-video/cli")) {
    errors.push(
      `Demo script does not import from '@argo-video/cli'. ` +
      `Use: import { test } from '@argo-video/cli'`
    );
  }

  // Extract scene names from narration.mark() calls
  const markRegex = /narration\.mark\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  const scriptScenes = new Set<string>();
  let match;
  while ((match = markRegex.exec(scriptContent)) !== null) {
    scriptScenes.add(match[1]);
  }

  if (scriptScenes.size === 0) {
    warnings.push('No narration.mark() calls found in demo script. The video will have no scene timing.');
  }

  // Check unified scenes manifest
  const scenesPath = join(demosDir, `${demoName}.scenes.json`);
  if (existsSync(scenesPath)) {
    try {
      const scenes = JSON.parse(readFileSync(scenesPath, 'utf-8'));
      if (!Array.isArray(scenes)) {
        errors.push(`Scenes manifest must be a JSON array`);
      } else {
        const validTypes = new Set(['lower-third', 'headline-card', 'callout', 'image-card', 'arrow', 'block', 'hf-component', 'hf-block']);
        const validPlacements = new Set(['bottom-center', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'center']);
        const validMotions = new Set(['none', 'fade-in', 'slide-in']);

        // Validate root-level voiceover fields
        for (let i = 0; i < scenes.length; i++) {
          const entry = scenes[i];
          if (!entry.scene) errors.push(`Scene entry ${i}: missing "scene" field`);
          // text is optional — scenes without text are silent (no TTS)
          if (entry.scene && !scriptScenes.has(entry.scene)) {
            warnings.push(`Scene "${entry.scene}" has no matching narration.mark() in the demo script`);
          }

          // Validate overlay sub-object if present
          if (entry.overlay) {
            const ov = entry.overlay;
            if (!ov.type) errors.push(`Scene "${entry.scene}" overlay: missing "type" field`);
            if (ov.type && !validTypes.has(ov.type)) {
              errors.push(`Scene "${entry.scene}" overlay: unknown type "${ov.type}"`);
            }
            if (ov.placement && !validPlacements.has(ov.placement)) {
              errors.push(`Scene "${entry.scene}" overlay: unknown placement "${ov.placement}"`);
            }
            if (ov.motion !== undefined) {
              if (typeof ov.motion === 'string') {
                if (!validMotions.has(ov.motion)) {
                  errors.push(`Scene "${entry.scene}" overlay: unknown motion "${ov.motion}"`);
                }
              } else if (isGsapMotion(ov.motion)) {
                const gsapErrors = validateGsapMotion(ov.motion, { allowRaw: options.allowRawGsap });
                for (const e of gsapErrors) {
                  const suffix = e.path ? ` (${e.path})` : '';
                  errors.push(`Scene "${entry.scene}" overlay.motion${suffix}: ${e.message}`);
                }
              } else {
                errors.push(
                  `Scene "${entry.scene}" overlay: motion must be a string preset or a GSAP motion object (type: 'gsap')`,
                );
              }
            }
            // Validate block-specific fields
            if (ov.type === 'block') {
              const { isValidBlockName } = await import('./blocks/index.js');
              if (typeof ov.block !== 'string' || !ov.block) {
                errors.push(`Scene "${entry.scene}" overlay: "block" field is required when type="block"`);
              } else if (!isValidBlockName(ov.block)) {
                errors.push(`Scene "${entry.scene}" overlay: unknown block "${ov.block}"`);
              }
              if (!ov.props || typeof ov.props !== 'object') {
                errors.push(`Scene "${entry.scene}" overlay: "props" object is required when type="block"`);
              }
            }
            // Validate hf-component / hf-block fields — both install to the same
            // blocksDir/<name>/<name>.html layout.
            if (ov.type === 'hf-component' || ov.type === 'hf-block') {
              if (!ov.name || typeof ov.name !== 'string') {
                errors.push(`Scene "${entry.scene}" overlay: ${ov.type} requires a "name" field`);
              } else if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(ov.name)) {
                errors.push(`Scene "${entry.scene}" overlay: invalid ${ov.type} name "${ov.name}"`);
              } else {
                const blocksDir = options.blocksDir ?? 'blocks';
                const componentFile = join(blocksDir, ov.name, `${ov.name}.html`);
                if (!existsSync(componentFile)) {
                  errors.push(
                    `Scene "${entry.scene}" overlay: ${ov.type} "${ov.name}" is not installed ` +
                      `(missing ${componentFile}). Run: argo add ${ov.name}`,
                  );
                }
              }
            }
            // Validate hf-block fit shape
            if (ov.type === 'hf-block' && ov.fit !== undefined && ov.fit !== 'cover') {
              const fit = ov.fit;
              if (
                typeof fit !== 'object' || fit === null ||
                typeof fit.x !== 'number' || typeof fit.y !== 'number' || typeof fit.scale !== 'number'
              ) {
                errors.push(
                  `Scene "${entry.scene}" overlay: hf-block "fit" must be 'cover' or { x, y, scale } with numeric fields`,
                );
              }
            }
          }
        }

        // Check for script scenes missing from manifest
        const manifestScenes = new Set(scenes.map((e: any) => e.scene).filter(Boolean));
        for (const scene of scriptScenes) {
          if (!manifestScenes.has(scene)) {
            warnings.push(`Script scene "${scene}" has no entry in scenes manifest — it will be silent`);
          }
        }
      }
    } catch (err) {
      errors.push(`Scenes manifest is not valid JSON: ${(err as Error).message}`);
    }
  } else {
    warnings.push(`No scenes manifest found at ${scenesPath}`);
  }

  return { errors, warnings };
}
