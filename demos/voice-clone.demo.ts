import { test } from '@argo-video/cli';
import { showOverlay, withOverlay, showConfetti } from '@argo-video/cli';
import { spotlight, focusRing, dimAround, zoomTo, resetCamera } from '@argo-video/cli';

test('voice-clone', async ({ page, narration }) => {
  test.setTimeout(120000);
  await page.goto('/voice-clone.html');
  await page.waitForTimeout(800);

  // Scene 1: Hero — spotlight the waveform + headline overlay
  narration.mark('hero');
  spotlight(page, '#hero-waveform', { duration: 5000, padding: 24 });
  await showOverlay(page, 'hero', {
    type: 'headline-card',
    kicker: 'VOICE CLONING',
    title: 'Your voice. Your demos.',
    body: 'Clone your voice from a 15-second clip — 100% local.',
    placement: 'top-right',
    motion: 'slide-in',
    autoBackground: true,
  }, narration.durationFor('hero', { maxMs: 8000 }));

  // Scene 2: Workflow — zoom through each step
  narration.mark('workflow');
  await page.locator('#workflow').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await withOverlay(page, 'workflow', {
    type: 'headline-card',
    title: 'Record. Preview. Pipeline.',
    placement: 'top-left',
    motion: 'slide-in',
    autoBackground: true,
  }, async () => {
    const stepDur = Math.floor(narration.durationFor('workflow') / 4);
    await zoomTo(page, '#step-record', { scale: 1.22, duration: stepDur, wait: true });
    await zoomTo(page, '#step-preview', { scale: 1.22, duration: stepDur, wait: true });
    await zoomTo(page, '#step-pipeline', { scale: 1.22, duration: stepDur, wait: true });
    await resetCamera(page);
  });

  // Scene 3: Features — dim through each feature card
  narration.mark('features');
  await page.locator('#features').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await withOverlay(page, 'features', {
    type: 'callout',
    text: 'Local, fast, high-fidelity, and manifest-driven',
    placement: 'top-left',
    motion: 'fade-in',
    autoBackground: true,
  }, async () => {
    const cardDur = Math.floor(narration.durationFor('features') / 5);
    await dimAround(page, '#feature-local', { duration: cardDur, wait: true });
    await dimAround(page, '#feature-preview', { duration: cardDur, wait: true });
    await dimAround(page, '#feature-quality', { duration: cardDur, wait: true });
    await dimAround(page, '#feature-manifest', { duration: cardDur, wait: true });
    await resetCamera(page);
  });

  // Scene 4: Record reference — focus on the terminal
  narration.mark('record-ref');
  await page.locator('#record-ref').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  focusRing(page, '#record-terminal', { color: '#8b5cf6', duration: narration.durationFor('record-ref') });
  await showOverlay(page, 'record-ref', {
    type: 'lower-third',
    text: 'One script captures and normalizes your reference voice',
    placement: 'top-left',
    motion: 'fade-in',
    autoBackground: true,
  }, narration.durationFor('record-ref'));

  // Scene 5: Preview clips — focus on preview terminal
  narration.mark('preview-clips');
  await page.locator('#preview').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  focusRing(page, '#preview-terminal', { color: '#06b6d4', duration: narration.durationFor('preview-clips') });
  await showOverlay(page, 'preview-clips', {
    type: 'lower-third',
    text: 'Preview each cloned clip before the full pipeline run',
    placement: 'top-right',
    motion: 'fade-in',
    autoBackground: true,
  }, narration.durationFor('preview-clips'));

  // Scene 6: Config — zoom into the code block
  narration.mark('config');
  await page.locator('#config').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await zoomTo(page, '#config-code', { scale: 1.3, duration: narration.durationFor('config'), wait: false });
  await showOverlay(page, 'config', {
    type: 'lower-third',
    text: 'Point your config at mlx-audio with refAudio — done',
    placement: 'top-left',
    motion: 'fade-in',
    autoBackground: true,
  }, narration.durationFor('config'));
  await resetCamera(page);

  // Scene 7: Models — dim through model cards
  narration.mark('models');
  await page.locator('#models').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await withOverlay(page, 'models', {
    type: 'callout',
    text: 'Qwen3-TTS delivers the best clone quality',
    placement: 'top-right',
    motion: 'fade-in',
    autoBackground: true,
  }, async () => {
    const modelDur = Math.floor(narration.durationFor('models') / 4);
    await dimAround(page, '#model-spark', { duration: modelDur, wait: true });
    await dimAround(page, '#model-qwen3', { duration: modelDur, wait: true });
    await dimAround(page, '#model-csm', { duration: modelDur, wait: true });
    await resetCamera(page);
  });

  // Scene 8: Argo preview feature — spotlight the terminal + zoom features
  narration.mark('argo-preview');
  await page.locator('#argo-preview').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  spotlight(page, '#argo-preview-terminal', { duration: narration.durationFor('argo-preview') / 2, padding: 12 });
  await showOverlay(page, 'argo-preview', {
    type: 'headline-card',
    kicker: 'NEW',
    title: 'argo preview',
    body: 'Edit voiceover, overlays, and timing in your browser.',
    placement: 'top-right',
    motion: 'slide-in',
    autoBackground: true,
  }, narration.durationFor('argo-preview') / 2);
  const prevDur = Math.floor(narration.durationFor('argo-preview') / 4);
  await dimAround(page, '#preview-edit', { duration: prevDur, wait: true });
  await dimAround(page, '#preview-regen', { duration: prevDur, wait: true });
  await resetCamera(page);

  // Scene 9: Result flow + mic drop
  narration.mark('result');
  await page.locator('#result').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const flowDur = Math.floor(narration.durationFor('result') / 5);
  await spotlight(page, '#result-mic', { duration: flowDur, padding: 16, wait: true });
  await spotlight(page, '#result-manifest', { duration: flowDur, padding: 16, wait: true });
  await spotlight(page, '#result-preview', { duration: flowDur, padding: 16, wait: true });
  await spotlight(page, '#result-video', { duration: flowDur, padding: 16, wait: true });
  showConfetti(page, { spread: 'burst', duration: 3000, pieces: 180 });
  await showOverlay(page, 'result', {
    type: 'lower-third',
    text: 'Your voice. Your demos. Powered by Argo.',
    placement: 'top-left',
    motion: 'fade-in',
    autoBackground: true,
  }, narration.durationFor('result', { minMs: 2800, leadOutMs: 400 }));
});
