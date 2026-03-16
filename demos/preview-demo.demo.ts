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
  await showOverlay(page, 'intro', narration.durationFor('intro', { maxMs: 8000 }));

  // Scene 2: Video player — hit play icon and show playback
  narration.mark('play-video');
  await spotlight(page, '.video-container', {
    duration: narration.durationFor('play-video') / 2,
    padding: 8,
    wait: true,
  });
  await page.locator('#btn-play').click({ force: true });
  await showOverlay(page, 'play-video', narration.durationFor('play-video') / 2);
  // Pause via the main play button
  await page.locator('#btn-play').click({ force: true });

  // Scene 3: Browse scenes — click through scene cards in sidebar
  narration.mark('browse-scenes');
  const sceneCards = page.locator('.scene-card');
  const cardCount = await sceneCards.count();
  if (cardCount >= 3) {
    await withOverlay(page, 'browse-scenes', async () => {
      const browseDur = Math.floor(narration.durationFor('browse-scenes') / 4);
      await sceneCards.nth(1).click();
      focusRing(page, '.scene-card.active', { color: '#8b5cf6', duration: browseDur });
      await page.waitForTimeout(browseDur);
      await sceneCards.nth(3).click();
      focusRing(page, '.scene-card.active', { color: '#8b5cf6', duration: browseDur });
      await page.waitForTimeout(browseDur);
      await sceneCards.nth(0).click();
      focusRing(page, '.scene-card.active', { color: '#8b5cf6', duration: browseDur });
      await page.waitForTimeout(browseDur);
    });
  }

  // Scene 4: Edit voiceover text — type replacement, show dirty + undo
  narration.mark('edit-text');
  const firstScene = page.locator('.scene-card').first();
  await firstScene.scrollIntoViewIfNeeded();
  const textarea = firstScene.locator('textarea[data-field="text"]');
  await textarea.scrollIntoViewIfNeeded();
  focusRing(page, 'textarea[data-field="text"]', {
    color: '#06b6d4',
    duration: narration.durationFor('edit-text'),
  });
  await textarea.click();
  await textarea.selectText();
  await demoType(page, textarea, 'Meet Argo — the fastest way to create polished product demos with AI voiceover.', 30);
  // Show the undo button that appeared + dirty save indicator
  await page.waitForTimeout(500);
  const undoBtn = firstScene.locator('.btn-undo');
  if (await undoBtn.isVisible()) {
    focusRing(page, '.btn-undo', { color: '#f59e0b', duration: 1500 });
    await page.waitForTimeout(1500);
  }
  await showOverlay(page, 'edit-text', narration.durationFor('edit-text', { minMs: 2000, leadOutMs: 300 }));

  // Scene 5: Edit overlay — change type and placement, live preview updates
  narration.mark('edit-overlay');
  const overlayType = firstScene.locator('select[data-field="overlay-type"]');
  await overlayType.scrollIntoViewIfNeeded();
  await withOverlay(page, 'edit-overlay', async () => {
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

  // Scene 6: Regen TTS
  narration.mark('regen-tts');
  const regenBtn = firstScene.locator('button', { hasText: 'Regen TTS' });
  await regenBtn.scrollIntoViewIfNeeded();
  spotlight(page, '.scene-card:first-child .btn-accent', {
    duration: narration.durationFor('regen-tts'),
    padding: 12,
  });
  await showOverlay(page, 'regen-tts', narration.durationFor('regen-tts'));

  // Scene 7: Save + Re-record — show both buttons
  narration.mark('save');
  const saveBtn = page.locator('#btn-save');
  const rerecordBtn = page.locator('#btn-rerecord');
  await saveBtn.scrollIntoViewIfNeeded();
  // Highlight save (should be amber/dirty) then re-record
  spotlight(page, '#btn-save', { duration: 1500, padding: 8 });
  await page.waitForTimeout(1500);
  spotlight(page, '#btn-rerecord', { duration: 1500, padding: 8 });
  await page.waitForTimeout(1000);
  await saveBtn.click();
  await showOverlay(page, 'save', narration.durationFor('save'));

  // Scene 8: Toggle controls — audio and overlay switches
  narration.mark('controls');
  const audioToggle = page.locator('label.toggle-switch[title="Audio"]');
  const overlayToggle = page.locator('label.toggle-switch[title="Overlays"]');
  await withOverlay(page, 'controls', async () => {
    const toggleDur = Math.floor(narration.durationFor('controls') / 3);
    focusRing(page, 'label[title="Overlays"]', { color: '#f59e0b', duration: toggleDur });
    await overlayToggle.click();
    await page.waitForTimeout(toggleDur);
    await overlayToggle.click();
    focusRing(page, 'label[title="Audio"]', { color: '#f59e0b', duration: toggleDur });
    await audioToggle.click();
    await page.waitForTimeout(toggleDur);
    await audioToggle.click();
  });

  // Scene 9: Closing — confetti + wrap up
  narration.mark('closing');
  showConfetti(page, { spread: 'burst', duration: 3000, pieces: 180 });
  await showOverlay(page, 'closing', narration.durationFor('closing', { minMs: 3000, leadOutMs: 600 }));
});
