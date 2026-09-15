import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdirSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  installCommand,
  isModuleNotFound,
  missingDependencyError,
  importOptional,
  isDepInstalled,
  detectInstallMode,
  resetInstallModeCache,
  KOKORO_DEP,
  TRANSFORMERS_DEP,
  WHISPER_DEP,
  MUSICGEN_DEP,
  OPENAI_DEP,
  ELEVENLABS_DEP,
  GEMINI_DEP,
  SARVAM_DEP,
  type OptionalDepSpec,
  type InstallMode,
} from '../src/optional-deps.js';

/** `src/`, where `isDepInstalled` resolves from. A fixture placed under
 *  `src/node_modules` is therefore the first thing its probe finds. */
const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Every spec Argo ships. Add new engines here so the shell-safety check
 *  below covers them. */
const ALL_SPECS: OptionalDepSpec[] = [
  KOKORO_DEP,
  TRANSFORMERS_DEP,
  WHISPER_DEP,
  MUSICGEN_DEP,
  OPENAI_DEP,
  ELEVENLABS_DEP,
  GEMINI_DEP,
  SARVAM_DEP,
];

/** A spec pointing at a package that is deliberately not installed. */
const MISSING_DEP: OptionalDepSpec = {
  feature: 'a package that does not exist',
  project: ['argo-no-such-package-xyz'],
  global: ['argo-no-such-package-xyz'],
};

describe('installCommand', () => {
  const cases: Array<[name: string, spec: OptionalDepSpec, mode: InstallMode, expected: string]> = [
    ['project mode installs plainly', OPENAI_DEP, 'project', 'npm i openai'],
    ['global mode adds -g', OPENAI_DEP, 'global', 'npm i -g openai'],
    // Kokoro names both packages in ONE global command: two separate
    // `npm i -g` runs do not dedupe and leave a second copy of onnxruntime
    // (~840MB vs ~410MB). In project mode npm hoists it, so one name is enough.
    [
      'global Kokoro names both packages in one command',
      KOKORO_DEP,
      'global',
      'npm i -g kokoro-js@1 @huggingface/transformers@3',
    ],
    ['project Kokoro omits the hoisted transformers', KOKORO_DEP, 'project', 'npm i kokoro-js@1'],
    [
      'transformers specs pin the major kokoro-js shares',
      WHISPER_DEP,
      'project',
      'npm i @huggingface/transformers@3',
    ],
    [
      'npx composes packages onto the invocation',
      OPENAI_DEP,
      'npx',
      'npx -p @argo-video/cli -p openai -- argo <command>',
    ],
  ];

  it.each(cases)('%s', (_name, spec, mode, expected) => {
    expect(installCommand(spec, mode)).toBe(expected);
  });
});

describe('isModuleNotFound', () => {
  it('recognises both ESM and CJS resolution failures', () => {
    expect(isModuleNotFound({ code: 'ERR_MODULE_NOT_FOUND' })).toBe(true);
    expect(isModuleNotFound({ code: 'MODULE_NOT_FOUND' })).toBe(true);
  });

  it('does not claim unrelated errors', () => {
    expect(isModuleNotFound(new Error('boom'))).toBe(false);
    expect(isModuleNotFound({ code: 'ECONNREFUSED' })).toBe(false);
    expect(isModuleNotFound(null)).toBe(false);
    expect(isModuleNotFound(undefined)).toBe(false);
  });
});

describe('missingDependencyError', () => {
  it('names the feature, the package, and the command', () => {
    const err = missingDependencyError(WHISPER_DEP);
    expect(err.message).toContain('Whisper word-level transcription');
    expect(err.message).toContain("'@huggingface/transformers'");
    expect(err.message).toContain('Install it with:');
  });

  it('strips version ranges from the package name it reports', () => {
    const spec: OptionalDepSpec = {
      feature: 'test',
      project: ['some-pkg@3'],
      global: ['some-pkg@3'],
    };
    expect(missingDependencyError(spec).message).toContain("'some-pkg'");
    expect(missingDependencyError(spec).message).not.toContain("'some-pkg@3'");
  });
});

describe('install commands are safe to paste', () => {
  // `^` is a glob operator under zsh's `extendedglob`, where a pasted
  // `npm i pkg@^3` dies with `no matches found` before npm ever runs. It also
  // defeats `bareName`, which would leave `pkg@^3` as the name to resolve and
  // report a present package as missing. Write ranges as `@3`.
  it.each(ALL_SPECS)('$feature avoids shell metacharacters', (spec) => {
    for (const entry of [...spec.project, ...spec.global]) {
      expect(entry).not.toContain('^');
    }
  });
});

describe('importOptional', () => {
  it('returns the module when the import succeeds', async () => {
    const mod = await importOptional(async () => ({ ok: 1 }), OPENAI_DEP);
    expect(mod).toEqual({ ok: 1 });
  });

  it('converts a missing package into an actionable error', async () => {
    const notFound = Object.assign(new Error('nope'), { code: 'ERR_MODULE_NOT_FOUND' });
    await expect(
      importOptional(() => Promise.reject(notFound), MISSING_DEP),
    ).rejects.toThrow(/optional dependency and is not installed/);
  });

  it('lets a genuine fault inside an installed package propagate unchanged', async () => {
    // A package that IS installed but throws on load must not be reported as
    // missing, or the user is told to install something they already have.
    const boom = new Error('the package itself is broken');
    await expect(
      importOptional(() => Promise.reject(boom), OPENAI_DEP),
    ).rejects.toThrow('the package itself is broken');
  });

  it('does not blame the package when a transitive dep is what went missing', async () => {
    // onnxruntime-node require()s a per-arch native binding at runtime. On a
    // machine without a matching prebuilt, that surfaces as MODULE_NOT_FOUND
    // from three levels down. Telling the user to install openai, which they
    // demonstrably have, sends them in circles.
    const transitive = Object.assign(
      new Error("Cannot find module './bin/napi-v3/linux/arm64/binding.node'"),
      { code: 'MODULE_NOT_FOUND' },
    );
    await expect(
      importOptional(() => Promise.reject(transitive), OPENAI_DEP),
    ).rejects.toThrow(/binding\.node/);
  });

  it('preserves the original error as `cause`', async () => {
    const notFound = Object.assign(new Error('nope'), { code: 'ERR_MODULE_NOT_FOUND' });
    const err = await importOptional(() => Promise.reject(notFound), MISSING_DEP).catch(
      (e: Error & { cause?: unknown }) => e,
    );
    expect(err.cause).toBe(notFound);
  });
});

describe('isDepInstalled', () => {
  it('finds a package that is present', () => {
    // openai is a devDependency of this repo, so it resolves during tests.
    expect(isDepInstalled(OPENAI_DEP)).toBe(true);
  });

  it('reports a package that is absent', () => {
    expect(isDepInstalled(MISSING_DEP)).toBe(false);
  });

  it('ignores a version range attached to the specifier', () => {
    expect(isDepInstalled({ ...OPENAI_DEP, project: ['openai@4'] })).toBe(true);
  });

  it('still throws when the failure is a bug rather than a resolution', () => {
    // An empty `project` makes `bareName` throw a bare TypeError. Recovering
    // from that would hide the mistake behind a confident "installed".
    expect(() => isDepInstalled({ feature: 'malformed', project: [], global: [] })).toThrow(
      TypeError,
    );
  });

  describe('when the probe itself fails', () => {
    // A package can be present and still refuse to resolve: an `exports` map
    // with no condition matching the caller throws
    // `ERR_PACKAGE_PATH_NOT_EXPORTED`, which is what an interrupted or
    // mis-published install looks like. Answering "not installed" there would
    // tell the user to reinstall something they already have, and throwing
    // would take down `argo doctor`, the command they ran to diagnose it.
    const FIXTURE = join(SRC_DIR, 'node_modules', 'argo-broken-exports-fixture');

    beforeAll(() => {
      mkdirSync(FIXTURE, { recursive: true });
      writeFileSync(
        join(FIXTURE, 'package.json'),
        JSON.stringify({ name: 'argo-broken-exports-fixture', exports: { './sub': './sub.js' } }),
      );
    });
    // Remove only what was created. `src/node_modules` is covered by the
    // repo's `node_modules/` gitignore, so deleting a copy this test did not
    // make would be both silent and unrecoverable.
    afterAll(() => {
      rmSync(FIXTURE, { recursive: true, force: true });
      const parent = join(SRC_DIR, 'node_modules');
      if (readdirSync(parent).length === 0) rmdirSync(parent);
    });

    it('answers "not known to be absent" rather than throwing', () => {
      const spec: OptionalDepSpec = {
        feature: 'fixture',
        project: ['argo-broken-exports-fixture'],
        global: ['argo-broken-exports-fixture'],
      };
      expect(isDepInstalled(spec)).toBe(true);
    });
  });
});

describe('detectInstallMode', () => {
  beforeEach(() => resetInstallModeCache());

  it('reports project mode when running from the source checkout', () => {
    // Both probes resolve `@argo-video/cli` to this repo's own `dist/`, via
    // Node's self-reference (the root manifest has both `name` and `exports`),
    // so they match and the mode is project. Not the `selfEntry === null`
    // branch, which a source checkout cannot reach for the same reason.
    expect(detectInstallMode()).toBe('project');
  });

  // `detectInstallMode`'s own resolver-failure fallback has no test here: the
  // self-reference above always wins for Argo's own name, so no fixture under
  // `src/node_modules` can shadow it, and reproducing it needs a real
  // installed consumer tree with a broken `exports` map. Verified by hand
  // there instead: `argo doctor` prints its table rather than exiting 1.

  it('caches the result instead of recomputing', () => {
    const first = detectInstallMode();
    const spy = vi.spyOn(process, 'cwd');
    expect(detectInstallMode()).toBe(first);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
