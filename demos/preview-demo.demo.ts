/**
 * Demo: argo preview — browser-based editing for voiceover, overlays, and timing.
 *
 * Prerequisites:
 *   1. Run a pipeline first:  npx argo pipeline showcase
 *   2. Start preview server:  npx argo preview showcase --port 9876
 *   3. Run this demo:         BASE_URL=http://127.0.0.1:9876 npx argo pipeline preview-demo
 */
import { test, demoType } from '@argo-video/cli';
import { showOverlay, withOverlay, showConfetti } from '@argo-video/cli';
import { spotlight, focusRing, dimAround, zoomTo, resetCamera } from '@argo-video/cli';

test('preview-demo', async ({ page, narration }) => {
  test.setTimeout(120000);
  await page.goto('/');
  await page.waitForTimeout(1200);

  // Scene 1: Hero — show the full preview layout
  narration.mark('intro');
  await showOverlay(page, 'intro', {
    type: 'headline-card',
    kicker: 'NEW IN ARGO',
    title: 'argo preview',
    body: 'Edit voiceover, overlays, and timing — without re-recording.',
    placement: 'top-right',
    motion: 'slide-in',
    autoBackground: true,
  }, narration.durationFor('intro', { maxMs: 8000 }));

  // Scene 2: Video player — hit play and show playback
  narration.mark('play-video');
  await spotlight(page, '#video', {
    duration: narration.durationFor('play-video') / 2,
    padding: 8,
    wait: true,
  });
  await page.click('#btn-play');
  await showOverlay(page, 'play-video', {
    type: 'lower-third',
    text: 'Video and audio play in sync — scrub the timeline to jump around',
    placement: 'top-left',
    motion: 'fade-in',
    autoBackground: true,
  }, narration.durationFor('play-video') / 2);
  // Pause after showing playback
  await page.click('#btn-play');

  // Scene 3: Browse scenes — click through scene cards in sidebar
  narration.mark('browse-scenes');
  const sceneCards = page.locator('.scene-card');
  const cardCount = await sceneCards.count();
  if (cardCount >= 3) {
    await withOverlay(page, 'browse-scenes', {
      type: 'callout',
      text: 'Click any scene to jump to it',
      placement: 'top-left',
      motion: 'fade-in',
      autoBackground: true,
    }, async () => {
      const browseDur = Math.floor(narration.durationFor('browse-scenes') / 4);
      // Click through first few scene cards
      await sceneCards.nth(1).click();
      focusRing(page, '.scene-card.active', { color: '#8b5cf6', duration: browseDur });
      await page.waitForTimeout(browseDur);
      await sceneCards.nth(3).click();
      focusRing(page, '.scene-card.active', { color: '#8b5cf6', duration: browseDur });
      await page.waitForTimeout(browseDur);
      // Click back to first scene
      await sceneCards.nth(0).click();
      focusRing(page, '.scene-card.active', { color: '#8b5cf6', duration: browseDur });
      await page.waitForTimeout(browseDur);
    });
  }

  // Scene 4: Edit voiceover text — focus on a textarea and type
  narration.mark('edit-text');
  const firstScene = page.locator('.scene-card').first();
  await firstScene.scrollIntoViewIfNeeded();
  const textarea = firstScene.locator('textarea[data-field="text"]');
  await textarea.scrollIntoViewIfNeeded();
  focusRing(page, 'textarea[data-field="text"]', {
    color: '#06b6d4',
    duration: narration.durationFor('edit-text'),
  });
  // Select all text and type a replacement
  await textarea.click();
  await textarea.selectText();
  await demoType(page, textarea, 'Meet Argo — the fastest way to create polished product demos with AI voiceover.', 30);
  await showOverlay(page, 'edit-text', {
    type: 'lower-third',
    text: 'Edit voiceover text inline — changes save to your manifest',
    placement: 'top-right',
    motion: 'fade-in',
    autoBackground: true,
  }, narration.durationFor('edit-text', { minMs: 2000, leadOutMs: 300 }));

  // Scene 5: Edit overlay — change the overlay type and placement
  narration.mark('edit-overlay');
  const overlayType = firstScene.locator('select[data-field="overlay-type"]');
  await overlayType.scrollIntoViewIfNeeded();
  await withOverlay(page, 'edit-overlay', {
    type: 'lower-third',
    text: 'Swap overlay templates and zones with dropdowns',
    placement: 'top-left',
    motion: 'fade-in',
    autoBackground: true,
  }, async () => {
    focusRing(page, 'select[data-field="overlay-type"]', {
      color: '#8b5cf6',
      duration: narration.durationFor('edit-overlay') / 2,
    });
    await overlayType.selectOption('headline-card');
    await page.waitForTimeout(800);

    const overlayPlacement = firstScene.locator('select[data-field="overlay-placement"]');
    focusRing(page, 'select[data-field="overlay-placement"]', {
      color: '#8b5cf6',
      duration: narration.durationFor('edit-overlay') / 2,
    });
    await overlayPlacement.selectOption('top-right');
    await page.waitForTimeout(800);
  });

  // Scene 6: Regen TTS — hit the regen button
  narration.mark('regen-tts');
  const regenBtn = firstScene.locator('button', { hasText: 'Regen TTS' });
  await regenBtn.scrollIntoViewIfNeeded();
  spotlight(page, '.scene-card:first-child .btn-accent', {
    duration: narration.durationFor('regen-tts'),
    padding: 12,
  });
  await showOverlay(page, 'regen-tts', {
    type: 'headline-card',
    kicker: 'SURGICAL UPDATES',
    title: 'Regen TTS',
    body: 'Regenerate just one scene — no need to re-run the full pipeline.',
    placement: 'top-right',
    motion: 'slide-in',
    autoBackground: true,
  }, narration.durationFor('regen-tts'));

  // Scene 7: Save — hit the save button
  narration.mark('save');
  const saveBtn = page.locator('#btn-save');
  await saveBtn.scrollIntoViewIfNeeded();
  spotlight(page, '#btn-save', { duration: 2000, padding: 8 });
  await page.waitForTimeout(1000);
  await saveBtn.click();
  await showOverlay(page, 'save', {
    type: 'lower-third',
    text: 'Save writes directly to your voiceover and overlay manifests',
    placement: 'top-left',
    motion: 'fade-in',
    autoBackground: true,
  }, narration.durationFor('save'));

  // Scene 8: Toggle controls — show audio and overlay toggles
  narration.mark('controls');
  const audioCheckbox = page.locator('#cb-audio');
  const overlayCheckbox = page.locator('#cb-overlays');
  await withOverlay(page, 'controls', {
    type: 'callout',
    text: 'Toggle audio and overlays on or off',
    placement: 'top-right',
    motion: 'fade-in',
    autoBackground: true,
  }, async () => {
    const toggleDur = Math.floor(narration.durationFor('controls') / 3);
    focusRing(page, '#cb-overlays', { color: '#f59e0b', duration: toggleDur });
    await overlayCheckbox.uncheck();
    await page.waitForTimeout(toggleDur);
    await overlayCheckbox.check();
    focusRing(page, '#cb-audio', { color: '#f59e0b', duration: toggleDur });
    await audioCheckbox.uncheck();
    await page.waitForTimeout(toggleDur);
    await audioCheckbox.check();
  });

  // Scene 9: Closing — confetti + wrap up
  narration.mark('closing');
  showConfetti(page, { spread: 'burst', duration: 3000, pieces: 180 });
  await showOverlay(page, 'closing', {
    type: 'headline-card',
    kicker: 'TRY IT',
    title: 'npx argo preview my-demo',
    body: 'Iterate on voiceover, overlays, and timing — all from your browser.',
    placement: 'top-right',
    motion: 'slide-in',
    autoBackground: true,
  }, narration.durationFor('closing', { minMs: 3000, leadOutMs: 600 }));
});
