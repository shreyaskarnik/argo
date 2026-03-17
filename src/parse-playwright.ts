/**
 * Parses a Playwright test/script and extracts logical scene boundaries
 * for converting into an Argo demo.
 */

export interface ParsedScene {
  /** Auto-generated scene name (kebab-case). */
  name: string;
  /** Lines of source code belonging to this scene. */
  lines: string[];
  /** Hint describing what happens in this scene (for LLM voiceover generation). */
  hint: string;
}

export interface ParsedPlaywrightTest {
  /** The test/function name found in the source. */
  testName: string;
  /** Detected scenes with their source lines and hints. */
  scenes: ParsedScene[];
  /** Original source lines (for reference). */
  sourceLines: string[];
  /** Imports found in the original file. */
  imports: string[];
}

interface PendingAction {
  line: string;
  hint: string;
}

/**
 * Pattern matchers for scene boundary detection.
 * Each returns a scene name suggestion and hint text if the line matches.
 */
const BOUNDARY_PATTERNS: Array<{
  regex: RegExp;
  sceneName: (match: RegExpMatchArray) => string;
  hint: (match: RegExpMatchArray, line: string) => string;
  /** If true, this is always a scene boundary. If false, only when followed by other actions. */
  alwaysBoundary: boolean;
}> = [
  // test.step('name', ...) — explicit steps are the strongest signal
  {
    regex: /test\.step\(\s*(['"`])(.+?)\1/,
    sceneName: (m) => slugify(m[2]),
    hint: (m) => `test.step: ${m[2]}`,
    alwaysBoundary: true,
  },
  // page.goto(url)
  {
    regex: /page\.goto\(\s*(['"`])(.+?)\1/,
    sceneName: (m) => slugifyUrl(m[2]),
    hint: (_m, line) => line.trim(),
    alwaysBoundary: true,
  },
  // page.goto(variable/expression)
  {
    regex: /page\.goto\((.+?)\)/,
    sceneName: () => 'navigate',
    hint: (_m, line) => line.trim(),
    alwaysBoundary: true,
  },
  // // Comment lines — strong candidate for scene label
  {
    regex: /^\s*\/\/\s*(.+)/,
    sceneName: (m) => slugify(m[1]),
    hint: (m) => `comment: ${m[1].trim()}`,
    alwaysBoundary: true,
  },
  // page.click / locator.click
  {
    regex: /\.click\(/,
    sceneName: () => 'click-action',
    hint: (_m, line) => line.trim(),
    alwaysBoundary: false,
  },
  // page.fill / locator.fill
  {
    regex: /\.fill\(/,
    sceneName: () => 'form-input',
    hint: (_m, line) => line.trim(),
    alwaysBoundary: false,
  },
  // expect(...).toBeVisible / toHaveText / etc.
  {
    regex: /expect\(.+?\)\.\w+/,
    sceneName: () => 'verify',
    hint: (_m, line) => line.trim(),
    alwaysBoundary: false,
  },
  // page.waitForSelector / page.waitForURL / locator.waitFor
  {
    regex: /\.waitFor(?:Selector|URL|Navigation)?\(/,
    sceneName: () => 'wait',
    hint: (_m, line) => line.trim(),
    alwaysBoundary: false,
  },
];

/** Lines that are structural and should not form their own scenes. */
const SKIP_PATTERNS = [
  /^\s*$/,                          // blank lines
  /^\s*import\s/,                   // imports
  /^\s*(?:const|let|var)\s/,        // variable declarations (unless they contain actions)
  /^\s*[{})\]];?\s*$/,              // lone braces/brackets
  /^\s*(?:test|describe)\s*\(/,     // test/describe wrappers
  /^\s*(?:test|describe)\.(?!step)\w+\(/,  // test.only, describe.skip, etc. (but NOT test.step)
  /^\s*async\s/,                    // async arrow functions
  /^\s*\}\s*\)\s*;?\s*$/,          // closing }) patterns
];

function shouldSkipLine(line: string): boolean {
  // Don't skip if line contains a Playwright action
  if (/page\.|locator|expect\(/.test(line)) return false;
  return SKIP_PATTERNS.some((p) => p.test(line));
}

/**
 * Parse a Playwright test file and extract scene boundaries.
 */
export function parsePlaywrightTest(source: string): ParsedPlaywrightTest {
  const sourceLines = source.split('\n');

  // Extract imports
  const imports = sourceLines.filter((l) => /^\s*import\s/.test(l));

  // Find the test name
  const testNameMatch = source.match(/test\(\s*(['"`])(.+?)\1/);
  const testName = testNameMatch?.[2] ?? 'demo';

  // Collect actions grouped into scenes
  const scenes: ParsedScene[] = [];
  let currentActions: PendingAction[] = [];
  let currentSceneName = '';
  /** True when the current scene was named by test.step — suppresses other boundary flushes. */
  let namedByStep = false;
  let sceneNameCounts = new Map<string, number>();

  function flushScene(): void {
    if (currentActions.length === 0) return;

    // Determine scene name
    let name = currentSceneName || inferSceneName(currentActions);
    name = deduplicateName(name, sceneNameCounts);

    scenes.push({
      name,
      lines: currentActions.map((a) => a.line),
      hint: currentActions.map((a) => a.hint).join(', '),
    });

    currentActions = [];
    currentSceneName = '';
    namedByStep = false;
  }

  for (const line of sourceLines) {
    if (shouldSkipLine(line)) continue;

    // Check if this line matches a boundary pattern
    let matched = false;
    for (const pattern of BOUNDARY_PATTERNS) {
      const m = line.match(pattern.regex);
      if (!m) continue;

      const isStep = pattern.regex.source.startsWith('test\\.step');

      if (isStep) {
        // test.step always starts a new scene
        if (currentActions.length > 0) flushScene();
        currentSceneName = pattern.sceneName(m);
        namedByStep = true;
      } else if (pattern.alwaysBoundary && !namedByStep && currentActions.length > 0) {
        // Other boundaries (goto, comments) flush only if not inside a test.step scene
        flushScene();
        currentSceneName = pattern.sceneName(m);
      } else if (!currentSceneName) {
        currentSceneName = pattern.sceneName(m);
      }

      currentActions.push({ line, hint: pattern.hint(m, line) });
      matched = true;
      break;
    }

    if (!matched && /page\.|locator|expect\(/.test(line)) {
      // It's a Playwright action but not a recognized pattern — still include it
      currentActions.push({ line, hint: line.trim() });
    }
  }

  // Flush remaining actions
  flushScene();

  return { testName, scenes, sourceLines, imports };
}

/**
 * Infer a scene name from the actions it contains.
 */
function inferSceneName(actions: PendingAction[]): string {
  for (const a of actions) {
    // Try to extract a meaningful name from selectors
    const selectorMatch = a.line.match(/['"`]([#.][a-zA-Z0-9_-]+)['"`]/);
    if (selectorMatch) {
      return slugify(selectorMatch[1].replace(/^[#.]/, ''));
    }
    // Try aria labels
    const ariaMatch = a.line.match(/getByRole\(.+?,\s*\{\s*name:\s*['"`](.+?)['"`]/);
    if (ariaMatch) {
      return slugify(ariaMatch[1]);
    }
    // Try getByText
    const textMatch = a.line.match(/getByText\(\s*['"`](.+?)['"`]/);
    if (textMatch) {
      return slugify(textMatch[1]);
    }
  }
  return 'step';
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // Keep at most 3 words for ergonomic scene names
  const words = slug.split('-').filter(Boolean).slice(0, 3);
  return words.join('-') || 'step';
}

function slugifyUrl(url: string): string {
  // Extract the meaningful path segment
  try {
    const pathname = new URL(url, 'http://localhost').pathname;
    const segment = pathname.split('/').filter(Boolean).pop() ?? 'home';
    return slugify(segment);
  } catch {
    return slugify(url);
  }
}

function deduplicateName(name: string, counts: Map<string, number>): string {
  const count = counts.get(name) ?? 0;
  counts.set(name, count + 1);
  return count === 0 ? name : `${name}-${count + 1}`;
}

/**
 * Generate an Argo demo script from a parsed Playwright test.
 */
export function generateDemoScript(parsed: ParsedPlaywrightTest): string {
  const lines: string[] = [];

  // Check if any scene lines contain expect() to decide on imports
  const hasExpect = parsed.scenes.some(s =>
    s.lines.some(l => /\bexpect\s*\(/.test(l))
  );

  if (hasExpect) {
    lines.push("import { test, expect } from '@argo-video/cli';");
  } else {
    lines.push("import { test } from '@argo-video/cli';");
  }
  lines.push("import { showOverlay, withOverlay } from '@argo-video/cli';");
  lines.push('');
  lines.push(`test('${parsed.testName}', async ({ page, narration }) => {`);

  for (const scene of parsed.scenes) {
    lines.push('');
    lines.push(`  narration.mark('${scene.name}');`);
    for (const sourceLine of scene.lines) {
      // Strip test.step() wrappers — we flatten steps into narration.mark() scenes
      const stripped = sourceLine
        .replace(/^\s*test\.step\s*\(\s*(['"`]).*?\1\s*,\s*async\s*\(\s*\)\s*=>\s*\{\s*$/, '')
        .replace(/^\s*\}\s*\)\s*;?\s*$/, '');
      if (stripped === '') continue;
      // Normalize indentation to 2-space inside the test block
      const trimmed = stripped.replace(/^\s+/, '');
      lines.push(`  ${trimmed}`);
    }
    lines.push(`  await page.waitForTimeout(narration.durationFor('${scene.name}'));`);
  }

  lines.push('});');
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate a unified scenes skeleton from parsed scenes.
 * Combines voiceover text, hints, and overlay config into one manifest.
 */
export function generateScenesSkeleton(
  parsed: ParsedPlaywrightTest,
): Array<{ scene: string; text: string; _hint: string; overlay: { type: string; text: string } }> {
  return parsed.scenes.map((s) => ({
    scene: s.name,
    text: '',
    _hint: s.hint,
    overlay: {
      type: 'lower-third',
      text: humanize(s.name),
    },
  }));
}

/**
 * @deprecated Use generateScenesSkeleton instead.
 * Generate a skeleton voiceover manifest from parsed scenes.
 * Includes _hint fields for LLM-assisted text generation.
 */
export function generateVoiceoverSkeleton(
  parsed: ParsedPlaywrightTest,
): Array<{ scene: string; text: string; _hint: string }> {
  return parsed.scenes.map((s) => ({
    scene: s.name,
    text: '',
    _hint: s.hint,
  }));
}

/**
 * @deprecated Use generateScenesSkeleton instead.
 * Generate a skeleton overlays manifest from parsed scenes.
 * Creates a lower-third for each scene as a starting point.
 */
export function generateOverlaysSkeleton(
  parsed: ParsedPlaywrightTest,
): Array<{ scene: string; type: string; text: string }> {
  return parsed.scenes.map((s) => ({
    scene: s.name,
    type: 'lower-third',
    text: humanize(s.name),
  }));
}

/** Convert kebab-case scene name to Title Case display text. */
function humanize(name: string): string {
  return name
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
