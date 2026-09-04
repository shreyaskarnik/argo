# SVG Pseudo Cursor and Brief Location Feedback

Use this reference when a demo needs a visible mouse pointer, click-location
feedback, or pointer interaction alongside multiple overlays. Verify that the
Argo build exports `createHumanCursor`; older releases only have the ring API.

## Choose the intended behavior

| Need | API / configuration |
|------|---------------------|
| Visible white SVG arrow | `await createHumanCursor(page, { seed, size, start })` |
| Brief click/accessibility-style circle | `video.cursorHighlight: { mode: 'click' }` |
| Persistent ring following the pointer | `video.cursorHighlight: true` or `{ mode: 'continuous' }` |
| Cursor positions for camera suggestions | `trackCursor(page, narration)`; telemetry does not draw a pointer |

In `mode: 'click'`, the SVG travels alone. A circle contracts toward the event
position on the first mouse event after highlight installation, a click, or
Control-key release. It fades away and is removed after 700 ms. The circle
stays at that position if the pointer moves away; rapid triggers restart one
circle rather than stacking circles. This is browser-rendered locator feedback,
not a change to the operating system's mouse settings.

The SVG's tip marks the actual click hotspot. `createHumanCursor()` produces
real Playwright mouse events; `cursorHighlight()` listens to those events and
owns the circle animation. Avoid duplicating click feedback in both helpers.
The native cursor is hidden while the SVG helper is installed.

## Configure and use the pointer

For automatic feedback during pipeline recording, put this under `video` in
`argo.config.mjs` or `demos/<name>.config.mjs`:

```javascript
video: {
  cursorHighlight: { mode: 'click', color: '#3b82f6', radius: 24, opacity: 0.9 },
}
```

The configuration enables circle feedback; the script still creates the SVG.
After navigating to the application, use the Argo fixture as follows:

```typescript
import { test, createHumanCursor, cursorHighlight, resetCursor, demoType } from '@argo-video/cli';

test('my-demo', async ({ page, narration }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await narration.startRecording(page);

  // Direct Playwright runs do not load the Argo recording configuration.
  if (!process.env.ARGO_CURSOR_HIGHLIGHT) {
    await cursorHighlight(page, { mode: 'click', radius: 24, opacity: 0.9 });
  }
  const cursor = await createHumanCursor(page, { seed: 'my-demo', size: 30 });
  try {
    narration.mark('search'); // Add the same scene to my-demo.scenes.json.
    const search = page.getByRole('textbox', { name: 'Search' });
    await cursor.click(search);
    await demoType(page, search, 'hello world');
    await cursor.moveTo(page.getByRole('button', { name: 'Submit' }), { durationMs: 900 });
    await page.waitForTimeout(narration.durationFor('search'));
  } finally {
    await cursor.dispose();
    await resetCursor(page);
  }
});
```

Use one instance across scenes so the next action starts at the previous
position. Seeded curves make paths reproducible; `moveTo` budgets travel from
distance unless `durationMs` is supplied. A `steps` argument on bare
`page.mouse.move()` interpolates positions but does not guarantee a slow glide.

`cursor.click(locator)` performs travel, pre-click dwell, press, release, and a
short pause. It accepts `durationMs`, `target`, `dwellMs`, `holdMs`, and `afterMs`.
`start` uses viewport fractions; movement `target` uses bounding-box fractions;
`size` is SVG width in CSS pixels. The default target is inside the control's
padding to reduce label obstruction. Use `cursor.click(field)` before
`demoType()` so typing follows visible travel.

Keep scene holds tied to `narration.durationFor()`. If a scene is mainly cursor
movement, budget its travel explicitly rather than assuming TTS will stretch
the moves. Use a fallback duration for deliberately silent scenes.

## Multiple overlays and location feedback

Each overlay zone has one slot. Nest `withOverlay()` calls in different zones
to keep all cues visible throughout an interaction and clean them up together:

```typescript
await withOverlay(page, 'interaction', {
  type: 'callout', text: 'Watch the click', placement: 'top-right',
}, async () => {
  await withOverlay(page, 'interaction', {
    type: 'lower-third', text: 'Choose a project', placement: 'bottom-left',
  }, async () => {
    await cursor.click(page.getByRole('button', { name: 'Choose project' }));
    await page.waitForTimeout(narration.durationFor('interaction'));
  });
});
```

Import `withOverlay` from `@argo-video/cli`. Both cues use the same marked
scene; the additional cue is inline rather than a second scenes manifest.
The SVG and locator circles render above overlays and do not intercept input.
Place captions away from controls and labels so the action remains readable.

To locate the pointer without a click, use `await page.keyboard.press('Control')`.
A release triggers one circle; repeated releases restart it. No application
click should occur during this demonstration.

## Navigation, cleanup, and recording checks

- The SVG helper restores itself after document navigation. Pipeline-enabled
  circle feedback is restored by the recording fixture; manual
  `cursorHighlight()` calls alone do not install a navigation listener.
- `cursor.hide()` hides only the SVG until its next move or click. It does not
  reset circle-feedback state or guarantee another appearance animation.
- `cursor.dispose()` removes the SVG, native-cursor override, and its listeners.
  Call `resetCursor(page)` separately to remove circle feedback and its listeners.
- Verify the exported video shows the arrow during travel, no persistent circle
  in click mode, a visible short circle at the click point, then no circle again.
  Also check Control releases do not activate controls, navigation restores the
  pointer, and controls remain clickable with the overlays visible.
- Chromium `jpeg-stitch` capture needs paint events. If removing the pointer
  leaves a static closing hold truncated, keep a small animated page element
  painting through the hold, as the demo's capture indicator does.

## Maintained demo

Use the repository's [demo script](../../../demos/pseudo-cursor.demo.ts),
[HTML playground](../../../demos/pseudo-cursor.html),
[recording config](../../../demos/pseudo-cursor.config.mjs), and
[scene manifest](../../../demos/pseudo-cursor.scenes.json) as a complete example.
It demonstrates appearance, clean travel, clicks, three simultaneous overlays,
navigation, Control location feedback, custom color, and cleanup.

From the repository root:

```bash
npm run build
node bin/argo.js validate pseudo-cursor
node bin/argo.js pipeline pseudo-cursor
```

Chromium and ffmpeg are required. The HTML is served through Playwright route
fulfillment and scenes omit narration text, so no app server, TTS engine, or
API keys are needed. Output: `videos/pseudo-cursor.mp4`.
