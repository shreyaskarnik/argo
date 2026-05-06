// Proves out renderComposition end-to-end. The demo is composed entirely of
// composition scenes — no recorded app — to validate the primitive in
// isolation. Real demos will mix recorded scenes with composition scenes
// (intros, outros, device frames around the recording).
import { test } from '@argo-video/cli';
import { renderComposition } from '@argo-video/cli';

test('composition-intro', async ({ page, narration }) => {
  test.setTimeout(30_000);

  await narration.startRecording(page);

  await renderComposition(page, narration, 'compositions/intro.html', {
    scene: 'intro',
    // durationMs omitted — composition's data-duration (3.5s) is honored.
  });
});
