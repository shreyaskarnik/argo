# Converting Existing Playwright Tests

## Usage

```bash
npx argo init --from tests/checkout.spec.ts           # auto-derives demo name
npx argo init --from tests/checkout.spec.ts --demo my-demo  # custom name
```

This generates:
- `demos/<name>.demo.ts` — fixture swapped to `@argo-video/cli`, `narration.mark()` + `durationFor()` inserted at scene boundaries
- `demos/<name>.scenes.json` — skeleton with `_hint` fields describing scene context, and lower-third overlay placeholders

## Scene Detection Heuristics

The parser finds scene boundaries via (strongest to weakest signal):
1. `test.step()` names
2. `page.goto()` navigations
3. `// comments` marking logical sections
4. Form fills grouped together
5. Click + assertion pairs

The parser is heuristic-based — generated scripts may need manual fixes, especially for chained Playwright expressions (e.g., `page.locator().filter().click()` may produce orphaned calls). Always review the generated demo script before recording.

## Post-Conversion LLM Workflow

After running `init --from`, follow these steps to complete the demo:

1. **Fill in voiceover text** — open `<name>.scenes.json`. Each entry has a `_hint` field describing the scene. Write natural narration for each `text` field using hints as context. Remove `_hint` fields when done.

2. **Add camera effects** — open `<name>.demo.ts`. Add `spotlight()`, `focusRing()`, `dimAround()` at key moments. Derive durations from `narration.durationFor()`:
   ```typescript
   const stepDur = Math.floor(narration.durationFor('checkout') / 3);
   spotlight(page, '#price-total', { duration: stepDur });
   ```

3. **Refine overlays** — upgrade placeholder lower-thirds to `headline-card`, `callout`, or `image-card` where appropriate. Add `motion: 'slide-in'` and `autoBackground: true`.

4. **Add `test.setTimeout()`** — if the demo exceeds 30 seconds, add `test.setTimeout(90000)` at the top.

5. **Apply phonetic fixes** — for Kokoro, spell tricky words phonetically in voiceover text (e.g., `sass` for SaaS). Not needed for OpenAI. See `references/tts-engines.md` for per-engine differences.

6. **Validate** — `npx argo validate <name>` checks scene name consistency.

7. **Record** — `npx argo pipeline <name>` to generate the video.
