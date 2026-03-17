import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface ValidateOptions {
  demoName: string;
  demosDir: string;
}

export interface ValidateResult {
  errors: string[];
  warnings: string[];
}

export function validateDemo(options: ValidateOptions): ValidateResult {
  const { demoName, demosDir } = options;
  const errors: string[] = [];
  const warnings: string[] = [];

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
        const validTypes = new Set(['lower-third', 'headline-card', 'callout', 'image-card']);
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
            if (ov.motion && !validMotions.has(ov.motion)) {
              errors.push(`Scene "${entry.scene}" overlay: unknown motion "${ov.motion}"`);
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
