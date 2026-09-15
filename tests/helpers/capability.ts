import { describe, it } from 'vitest';
import { chromium } from 'playwright';

/**
 * Choose a `describe` variant based on whether an external prerequisite — a
 * bindable loopback socket, a downloaded browser binary — is available.
 *
 * Locally these are legitimately missing: not every contributor has every
 * browser installed, and a sandbox may refuse to bind a port. Skipping is
 * right there.
 *
 * In CI they are installed on purpose, so a missing one means the workflow
 * drifted — a renamed install step, a soft failure — and silently skipping
 * retires the guard with a green build. That is the failure mode that let
 * `spotlight()` paint over its own target unnoticed, so in CI this fails
 * loudly instead.
 */
export function describeWithCapability(
  available: boolean,
  requirement: string,
): typeof describe {
  if (available) return describe;

  if (process.env.CI) {
    return ((name: string) =>
      describe(name, () => {
        it(`requires ${requirement}`, () => {
          throw new Error(
            `${requirement} was unavailable in CI, so these tests did not run. ` +
            'CI installs this deliberately — check the workflow rather than ' +
            'relaxing this assertion, because skipping here hides real regressions.',
          );
        });
      })) as unknown as typeof describe;
  }

  return describe.skip;
}

/**
 * Test-level counterpart to `describeWithCapability`, for suites that mix
 * tests needing a prerequisite with ones that don't. Replaces `it.runIf` /
 * `it.skipIf`, which skip silently in CI exactly like `describe.skip` did.
 */
export function itWithCapability(available: boolean, requirement: string): typeof it {
  if (available) return it;

  if (process.env.CI) {
    return ((name: string) =>
      it(`${name} (requires ${requirement})`, () => {
        throw new Error(
          `${requirement} was unavailable in CI, so "${name}" did not run. ` +
          'CI installs this deliberately — check the workflow rather than ' +
          'relaxing this assertion, because skipping here hides real regressions.',
        );
      })) as unknown as typeof it;
  }

  return it.skip;
}

/** Whether a headless Chromium can be launched on this machine. */
export async function canLaunchChromium(): Promise<boolean> {
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

