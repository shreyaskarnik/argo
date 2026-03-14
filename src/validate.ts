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

  // Check voiceover manifest
  const voiceoverPath = join(demosDir, `${demoName}.voiceover.json`);
  if (existsSync(voiceoverPath)) {
    try {
      const voiceover = JSON.parse(readFileSync(voiceoverPath, 'utf-8'));
      if (!Array.isArray(voiceover)) {
        errors.push(`Voiceover manifest must be a JSON array, got ${typeof voiceover}`);
      } else {
        for (let i = 0; i < voiceover.length; i++) {
          const entry = voiceover[i];
          if (!entry.scene) errors.push(`Voiceover entry ${i}: missing "scene" field`);
          if (!entry.text) errors.push(`Voiceover entry ${i}: missing "text" field`);
          if (entry.scene && !scriptScenes.has(entry.scene)) {
            warnings.push(
              `Voiceover scene "${entry.scene}" has no matching narration.mark('${entry.scene}') in the demo script`
            );
          }
        }

        // Check for script scenes missing voiceover
        const voiceoverScenes = new Set(voiceover.map((e: any) => e.scene).filter(Boolean));
        for (const scene of scriptScenes) {
          if (!voiceoverScenes.has(scene)) {
            warnings.push(`Script scene "${scene}" has no voiceover entry — it will be silent`);
          }
        }
      }
    } catch (err) {
      errors.push(`Voiceover manifest is not valid JSON: ${(err as Error).message}`);
    }
  } else {
    warnings.push(`No voiceover manifest found at ${voiceoverPath} — the video will have no narration`);
  }

  // Check overlay manifest (optional)
  const overlayPath = join(demosDir, `${demoName}.overlays.json`);
  if (existsSync(overlayPath)) {
    try {
      const overlays = JSON.parse(readFileSync(overlayPath, 'utf-8'));
      if (!Array.isArray(overlays)) {
        errors.push(`Overlay manifest must be a JSON array, got ${typeof overlays}`);
      } else {
        const validTypes = new Set(['lower-third', 'headline-card', 'callout', 'image-card']);
        const validPlacements = new Set(['bottom-center', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'center']);
        const validMotions = new Set(['none', 'fade-in', 'slide-in']);

        for (let i = 0; i < overlays.length; i++) {
          const entry = overlays[i];
          if (!entry.scene) errors.push(`Overlay entry ${i}: missing "scene" field`);
          if (!entry.type) errors.push(`Overlay entry ${i}: missing "type" field`);
          if (entry.type && !validTypes.has(entry.type)) {
            errors.push(`Overlay entry ${i}: unknown type "${entry.type}" (valid: ${[...validTypes].join(', ')})`);
          }
          if (entry.placement && !validPlacements.has(entry.placement)) {
            errors.push(`Overlay entry ${i}: unknown placement "${entry.placement}" (valid: ${[...validPlacements].join(', ')})`);
          }
          if (entry.motion && !validMotions.has(entry.motion)) {
            errors.push(`Overlay entry ${i}: unknown motion "${entry.motion}" (valid: ${[...validMotions].join(', ')})`);
          }
          if (entry.scene && !scriptScenes.has(entry.scene)) {
            warnings.push(`Overlay scene "${entry.scene}" has no matching narration.mark() in the demo script`);
          }
        }
      }
    } catch (err) {
      errors.push(`Overlay manifest is not valid JSON: ${(err as Error).message}`);
    }
  }

  return { errors, warnings };
}
