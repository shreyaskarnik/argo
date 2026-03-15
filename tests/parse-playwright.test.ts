import { describe, it, expect } from 'vitest';
import {
  parsePlaywrightTest,
  generateDemoScript,
  generateVoiceoverSkeleton,
  generateOverlaysSkeleton,
} from '../src/parse-playwright.js';

const SIMPLE_TEST = `
import { test, expect } from '@playwright/test';

test('login flow', async ({ page }) => {
  await page.goto('http://localhost:3000/login');
  await page.fill('#email', 'user@example.com');
  await page.fill('#password', 'secret');
  await page.click('button[type="submit"]');
  await expect(page.locator('.dashboard')).toBeVisible();
});
`;

const TEST_WITH_STEPS = `
import { test, expect } from '@playwright/test';

test('checkout', async ({ page }) => {
  test.step('Browse products', async () => {
    await page.goto('/products');
    await page.click('.product-card:first-child');
  });

  test.step('Add to cart', async () => {
    await page.click('#add-to-cart');
    await expect(page.locator('.cart-count')).toHaveText('1');
  });

  test.step('Complete purchase', async () => {
    await page.goto('/checkout');
    await page.fill('#card-number', '4242424242424242');
    await page.click('#pay-now');
  });
});
`;

const TEST_WITH_COMMENTS = `
import { test } from '@playwright/test';

test('onboarding', async ({ page }) => {
  // Navigate to signup
  await page.goto('/signup');

  // Fill in the registration form
  await page.fill('#name', 'Jane Doe');
  await page.fill('#email', 'jane@example.com');

  // Submit and verify
  await page.click('#register');
  await page.waitForURL('/welcome');
});
`;

const TEST_WITH_LOCATORS = `
import { test, expect } from '@playwright/test';

test('search', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Search' }).fill('argo');
  await page.getByText('Search').click();
  await expect(page.getByRole('heading', { name: 'Results' })).toBeVisible();
});
`;

describe('parsePlaywrightTest', () => {
  it('extracts test name', () => {
    const result = parsePlaywrightTest(SIMPLE_TEST);
    expect(result.testName).toBe('login flow');
  });

  it('detects scenes from page.goto', () => {
    const result = parsePlaywrightTest(SIMPLE_TEST);
    expect(result.scenes.length).toBeGreaterThanOrEqual(1);
    expect(result.scenes[0].name).toBe('login');
  });

  it('groups form fills into a scene', () => {
    const result = parsePlaywrightTest(SIMPLE_TEST);
    // The goto starts a scene, fills and click should be grouped
    const allHints = result.scenes.map((s) => s.hint).join(' ');
    expect(allHints).toContain('page.fill');
    expect(allHints).toContain('page.click');
  });

  it('uses test.step names as scene names', () => {
    const result = parsePlaywrightTest(TEST_WITH_STEPS);
    const names = result.scenes.map((s) => s.name);
    expect(names).toContain('browse-products');
    expect(names).toContain('add-to-cart');
    expect(names).toContain('complete-purchase');
  });

  it('uses comments as scene boundaries', () => {
    const result = parsePlaywrightTest(TEST_WITH_COMMENTS);
    const names = result.scenes.map((s) => s.name);
    expect(names).toContain('navigate-to-signup');
    expect(names).toContain('fill-in-the-registration-form');
    expect(names).toContain('submit-and-verify');
  });

  it('handles getByRole and getByText locators', () => {
    const result = parsePlaywrightTest(TEST_WITH_LOCATORS);
    expect(result.scenes.length).toBeGreaterThanOrEqual(1);
    const allHints = result.scenes.map((s) => s.hint).join(' ');
    expect(allHints).toContain('getByRole');
  });

  it('deduplicates scene names', () => {
    const source = `
import { test } from '@playwright/test';
test('dup', async ({ page }) => {
  await page.goto('/a');
  await page.click('#btn');
  await page.goto('/a');
  await page.click('#btn');
});
`;
    const result = parsePlaywrightTest(source);
    const names = result.scenes.map((s) => s.name);
    // Should not have duplicate names
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('returns empty scenes for non-Playwright code', () => {
    const result = parsePlaywrightTest('const x = 1;\nconsole.log(x);');
    expect(result.scenes).toHaveLength(0);
  });
});

describe('generateDemoScript', () => {
  it('produces valid Argo demo script', () => {
    const parsed = parsePlaywrightTest(SIMPLE_TEST);
    const script = generateDemoScript(parsed);

    // SIMPLE_TEST has expect() calls, so the import includes expect
    expect(script).toContain("import { test, expect } from '@argo-video/cli'");
    expect(script).toContain("import { showOverlay, withOverlay } from '@argo-video/cli'");
    expect(script).toContain("narration.mark('login')");
    expect(script).toContain("narration.durationFor('login')");
    expect(script).toContain('async ({ page, narration })');
  });

  it('includes mark + durationFor for each scene', () => {
    const parsed = parsePlaywrightTest(TEST_WITH_STEPS);
    const script = generateDemoScript(parsed);

    for (const scene of parsed.scenes) {
      expect(script).toContain(`narration.mark('${scene.name}')`);
      expect(script).toContain(`narration.durationFor('${scene.name}')`);
    }
  });

  it('preserves original Playwright actions', () => {
    const parsed = parsePlaywrightTest(SIMPLE_TEST);
    const script = generateDemoScript(parsed);

    expect(script).toContain("page.goto('http://localhost:3000/login')");
    expect(script).toContain("page.fill('#email'");
    expect(script).toContain("page.click('button[type=\"submit\"]')");
  });
});

describe('generateVoiceoverSkeleton', () => {
  it('creates entries with empty text and _hint for each scene', () => {
    const parsed = parsePlaywrightTest(TEST_WITH_STEPS);
    const voiceover = generateVoiceoverSkeleton(parsed);

    expect(voiceover.length).toBe(parsed.scenes.length);
    for (const entry of voiceover) {
      expect(entry).toHaveProperty('scene');
      expect(entry).toHaveProperty('text', '');
      expect(entry).toHaveProperty('_hint');
      expect(entry._hint.length).toBeGreaterThan(0);
    }
  });

  it('includes Playwright actions in hints', () => {
    const parsed = parsePlaywrightTest(SIMPLE_TEST);
    const voiceover = generateVoiceoverSkeleton(parsed);
    const allHints = voiceover.map((v) => v._hint).join(' ');

    expect(allHints).toContain('page.goto');
    expect(allHints).toContain('page.fill');
  });
});

describe('generateOverlaysSkeleton', () => {
  it('creates lower-third entries with humanized names', () => {
    const parsed = parsePlaywrightTest(TEST_WITH_STEPS);
    const overlays = generateOverlaysSkeleton(parsed);

    expect(overlays.length).toBe(parsed.scenes.length);
    for (const entry of overlays) {
      expect(entry.type).toBe('lower-third');
      expect(entry.scene).toBeTruthy();
      // Text should be Title Case
      expect(entry.text).toMatch(/^[A-Z]/);
    }
  });

  it('humanizes kebab-case scene names', () => {
    const parsed = parsePlaywrightTest(TEST_WITH_STEPS);
    const overlays = generateOverlaysSkeleton(parsed);
    const texts = overlays.map((o) => o.text);

    expect(texts).toContain('Browse Products');
    expect(texts).toContain('Add To Cart');
    expect(texts).toContain('Complete Purchase');
  });
});
