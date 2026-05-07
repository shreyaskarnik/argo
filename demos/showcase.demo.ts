/**
 * Canonical showcase demo.
 *
 * Each scene maps to a major Argo capability cluster so one recording can tell
 * the full product story without fragmenting into multiple demos.
 *
 * Prerequisites:
 *   1. Serve the HTML:  python3 -m http.server 8976 --directory demos
 *   2. Run pipeline:    npx tsx bin/argo.js pipeline showcase --config demos/showcase.config.mjs
 *   3. Optional clips:  npx argo release-prep showcase --gif
 */
import type { Page } from '@playwright/test';
import { test, demoType } from '@argo-video/cli';
import { showOverlay, withOverlay, showConfetti } from '@argo-video/cli';
import { spotlight, focusRing, dimAround, zoomTo, resetCamera } from '@argo-video/cli';
import { cursorHighlight, resetCursor } from '@argo-video/cli';
import { trackCursor } from '@argo-video/cli';

/**
 * Scroll a section into view, hold briefly so the new content visually settles,
 * then anchor the next narration scene at this moment. Mark()-ing before the
 * scroll lands gives 300–800ms of perceived audio lag.
 */
async function enterScene(
  page: Page,
  narration: { mark: (name: string) => void },
  selector: string,
  scene: string,
  holdMs = 400,
): Promise<void> {
  await page.locator(selector).scrollIntoViewIfNeeded();
  if (holdMs > 0) await page.waitForTimeout(holdMs);
  narration.mark(scene);
}

test('showcase', async ({ page, narration }) => {
  test.setTimeout(300_000);
  // Wait until `word` is next spoken in `scene`, or `fb` ms when the
  // transcript is unavailable or the word isn't in it.
  const waitForWord = (scene: string, word: string, fb: number) =>
    page.waitForTimeout(narration.atWord(scene, word) ?? fb);

  await page.goto('/showcase.html');
  trackCursor(page, narration);
  cursorHighlight(page, { color: '#60a5fa', radius: 18 });
  await page.waitForTimeout(700);

  // Begin screen capture — Playwright 1.59 page.screencast.start().
  // Re-anchors narration timestamps so the first mark lands at t=0
  // and no head-trim heuristic is needed in the export pipeline.
  await narration.startRecording(page);

  narration.mark('hero');
  spotlight(page, '#hero-command', { duration: 4800, padding: 18 });
  await showOverlay(page, 'hero', narration.durationFor('hero', { maxMs: 7800 }));

  // enterScene scrolls + settles + marks together so audio for the new scene
  // starts only once the new section is visible (otherwise mark() fires
  // immediately and audio leads the visuals by 300–800ms).
  await enterScene(page, narration, '#authoring', 'authoring');
  await withOverlay(page, 'authoring', async () => {
    const totalMs = narration.durationFor('authoring', { maxMs: 9200 }) - 400;
    const beat = Math.floor(totalMs / 5);
    await focusRing(page, '#step-from', { color: '#60a5fa', duration: beat, wait: true });
    await focusRing(page, '#step-import', { color: '#e879f9', duration: beat, wait: true });
    await focusRing(page, '#authoring-manifest', { color: '#22d3ee', duration: beat, wait: true });
    await focusRing(page, '#authoring-silent', { color: '#a78bfa', duration: beat, wait: true });
    await focusRing(page, '#authoring-duration', { color: '#f59e0b', duration: beat, wait: true });
  });

  await enterScene(page, narration, '#voiceover', 'voiceover');
  await withOverlay(page, 'voiceover', async () => {
    // Anchor words are Whisper transcript spellings, not manifest text —
    // Kokoro speaks "Kokoro" as "cochro" and "OpenAI" as "opening eye".
    const dim = 900;
    await waitForWord('voiceover', 'cochro', 3000);
    dimAround(page, '#engine-kokoro', { duration: dim });
    await waitForWord('voiceover', 'hugging', 1300);
    dimAround(page, '#engine-transformers', { duration: dim });
    await waitForWord('voiceover', 'opening', 1900);
    dimAround(page, '#engine-openai', { duration: dim });
    await waitForWord('voiceover', '11', 1100);
    dimAround(page, '#engine-elevenlabs', { duration: dim });
    // Gemini and Sarvam aren't named in narration — fill the gap.
    await page.waitForTimeout(700);
    dimAround(page, '#engine-gemini', { duration: dim });
    await page.waitForTimeout(800);
    dimAround(page, '#engine-sarvam', { duration: dim });
    await waitForWord('voiceover', 'MLX', 1200);
    dimAround(page, '#engine-mlx', { duration: dim });
    await waitForWord('voiceover', 'Audio', 700);
    focusRing(page, '#voiceover-config', { color: '#22d3ee', duration: 1200 });
    await page.waitForTimeout(1000);
    await resetCamera(page);
  });

  await enterScene(page, narration, '#preview-editor', 'preview');
  await withOverlay(page, 'preview', async () => {
    // 6 beats: command, drag, type, scrubber, regen, export
    const totalMs = narration.durationFor('preview', { maxMs: 9000 }) - 400;
    const beat = Math.floor(totalMs / 6);
    await focusRing(page, '#preview-command', { color: '#60a5fa', duration: beat, wait: true });
    await focusRing(page, '#preview-drag', { color: '#e879f9', duration: beat, wait: true });
    await demoType(page, '#preview-text-field', 'Tighten the preview voice line.');
    await page.waitForTimeout(Math.max(0, beat - 1800));
    await focusRing(page, '#preview-scrubber', { color: '#22d3ee', duration: beat, wait: true });
    await focusRing(page, '#preview-regen', { color: '#a78bfa', duration: beat, wait: true });
    await focusRing(page, '#preview-export', { color: '#4ade80', duration: beat, wait: true });
  });

  await enterScene(page, narration, '#camera-effects', 'camera');
  await waitForWord('camera', 'Spotlight', 3000);
  spotlight(page, '#effect-spotlight', { duration: 1400, padding: 10 });
  await waitForWord('camera', 'focus', 1500);
  focusRing(page, '#effect-focus-ring', { color: '#fb7185', duration: 1200 });
  await waitForWord('camera', 'dim', 1100);
  dimAround(page, '#effect-dim-around', { duration: 1100 });
  await waitForWord('camera', 'highlight', 1100);
  focusRing(page, '#effect-cursor', { color: '#60a5fa', duration: 1200 });
  await waitForWord('camera', 'zoom', 1200);
  // Post-export zoom on the zoomTo card itself — meta!
  zoomTo(page, '#effect-zoom', { narration, scale: 1.5, duration: 1500, fadeIn: 300, holdMs: 900 });
  await waitForWord('camera', 'motion', 1500);
  focusRing(page, '#effect-motion-blur', { color: '#a78bfa', duration: 1100 });
  await waitForWord('camera', 'confetti', 1500);
  showConfetti(page, { spread: 'rain', duration: 1500, pieces: 130 });
  await page.waitForTimeout(1200);
  await resetCamera(page);

  await enterScene(page, narration, '#export-stack', 'export');
  await withOverlay(page, 'export', async () => {
    const totalMs = narration.durationFor('export', { maxMs: 9800 }) - 400;
    const beat = Math.floor(totalMs / 7);
    await focusRing(page, '#export-transitions', { color: '#60a5fa', duration: beat, wait: true });
    await focusRing(page, '#export-audio', { color: '#22d3ee', duration: beat, wait: true });
    await focusRing(page, '#export-musicgen', { color: '#e879f9', duration: beat, wait: true });
    await focusRing(page, '#export-watermark', { color: '#a78bfa', duration: beat, wait: true });
    await focusRing(page, '#export-freeze', { color: '#f59e0b', duration: beat, wait: true });
    await focusRing(page, '#export-metadata', { color: '#4ade80', duration: beat, wait: true });
    await focusRing(page, '#export-formats', { color: '#fb7185', duration: beat, wait: true });
  });

  await enterScene(page, narration, '#studio-polish', 'studio');
  await withOverlay(page, 'studio', async () => {
    const totalMs = narration.durationFor('studio', { maxMs: 10000 }) - 400;
    // Flash 3 animated blocks in the bottom-left zone so the GSAP loops
    // (rotating ring, pulsing button, floating hero) are visible on screen.
    // Each block holds long enough to see at least one full loop cycle.
    const blockBeat = 2800;
    const beat = Math.max(1500, Math.floor((totalMs - blockBeat * 3) / 4));

    await showOverlay(page, 'studio', {
      type: 'block',
      block: 'tiktok-follow',
      props: { handle: '@argo', name: 'Argo' },
      placement: 'bottom-left',
      autoBackground: true,
    }, blockBeat);

    await showOverlay(page, 'studio', {
      type: 'block',
      block: 'instagram-follow',
      props: { handle: '@argo', name: 'Argo', verified: true },
      placement: 'bottom-left',
      autoBackground: true,
    }, blockBeat);

    await showOverlay(page, 'studio', {
      type: 'block',
      block: 'app-showcase',
      props: { title: 'Argo', subtitle: 'Demos as code.', cta: 'Get started', accentColor: '#60a5fa' },
      placement: 'bottom-left',
      autoBackground: true,
    }, blockBeat);

    await focusRing(page, '#polish-frame', { color: '#60a5fa', duration: beat, wait: true });
    await focusRing(page, '#polish-motion-blur', { color: '#e879f9', duration: beat, wait: true });
    await focusRing(page, '#polish-scene-speed', { color: '#22d3ee', duration: beat, wait: true });
    // Arrow annotation card — place a visible arrow near the lower-right card.
    showOverlay(page, 'studio-arrow', {
      type: 'arrow',
      direction: 'up-left',
      label: 'Look here',
      color: '#ef4444',
      size: 64,
      placement: 'bottom-right',
      motion: 'fade-in',
      autoBackground: true,
    }, beat);
    await focusRing(page, '#polish-arrows', { color: '#fb7185', duration: beat, wait: true });
  });

  await enterScene(page, narration, '#ops', 'ops');
  await withOverlay(page, 'ops', async () => {
    const totalMs = narration.durationFor('ops', { maxMs: 8200 }) - 400;
    const beat = Math.floor(totalMs / 4);
    await focusRing(page, '#ops-batch', { color: '#60a5fa', duration: beat, wait: true });
    await focusRing(page, '#ops-dashboard', { color: '#22d3ee', duration: beat, wait: true });
    await focusRing(page, '#ops-validate', { color: '#a78bfa', duration: beat, wait: true });
    await focusRing(page, '#ops-doctor', { color: '#4ade80', duration: beat, wait: true });
  });

  // No settle hold (holdMs=0) — preserves the original timing where mark()
  // fires immediately after scrollIntoViewIfNeeded() for this scene.
  // Also no post-export zoom on the code script: an earlier zoomTo recorded
  // #demo-script-card's bbox before the scroll had visually settled, so the
  // ffmpeg zoompan ended up cropping into the previous (ops) section's
  // content while audio said "Under the hood, it is still Playwright".
  // Letting the natural full-frame recording show through keeps sync.
  await enterScene(page, narration, '#code-example', 'code', 0);
  await showOverlay(page, 'code', narration.durationFor('code', { maxMs: 7600 }));

  // CTA section is min-height: 100vh with flexbox centering,
  // so scrolling it into view naturally fills the viewport.
  await enterScene(page, narration, '#cta', 'closing');
  await page.waitForTimeout(800);
  focusRing(page, '#theme-toggle', { color: '#f59e0b', duration: 1200 });
  await page.waitForTimeout(650);
  await page.click('#theme-toggle');
  await page.waitForTimeout(650);
  await showOverlay(page, 'closing', narration.durationFor('closing', { maxMs: 8200, leadOutMs: 700 }));

  // Mic-drop stays on the CTA section — no scroll, just confetti
  narration.mark('mic-drop');
  await resetCamera(page);
  resetCursor(page);
  showConfetti(page, { emoji: ['🎬', '🚀', '✨'], spread: 'burst', duration: 3200, pieces: 200 });
  await showOverlay(page, 'mic-drop', narration.durationFor('mic-drop', { minMs: 3000, leadOutMs: 500 }));
});
