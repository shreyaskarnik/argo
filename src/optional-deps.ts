/**
 * Optional engine dependencies: detection and actionable install hints.
 *
 * Argo's TTS engines and the Whisper transcriber are optional peer
 * dependencies. npm does not install them automatically, so the package
 * stays small for anyone who only uses one engine. When a code path needs
 * a package that isn't there, the error has to say exactly what to run.
 *
 * The correct command differs by how Argo itself was installed:
 *
 * - project (`npm i -D @argo-video/cli`): npm hoists the engine's own
 *   transitive deps to the project root, where Argo can resolve them.
 * - global (`npm i -g`): each global install is its own tree with no
 *   hoisting between them. `npm i -g kokoro-js` alone leaves
 *   `@huggingface/transformers` nested privately under `kokoro-js/`, where
 *   Argo cannot see it, so the global hint names both packages. They must
 *   go in ONE command: two separate `npm i -g` runs produce two copies of
 *   onnxruntime (~840MB vs ~410MB).
 * - npx: the throwaway tree holds only what `--package` put in it.
 */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, sep } from 'node:path';

export type InstallMode = 'project' | 'global' | 'npx';

const PKG_NAME = '@argo-video/cli';

/** `kokoro-js@1` -> `kokoro-js`. Install lists carry version ranges for the
 *  user to paste; resolution and error text want the bare name.
 *
 *  Only the digit-led forms the specs actually use are recognised. A range
 *  written `@^1` would survive into the "bare" name and resolve to nothing,
 *  which is why the specs are tested for `^` and must not contain it. */
function bareName(specifier: string): string {
  return specifier.replace(/@[\d.].*$/, '');
}

/** Resolve a bare specifier as if from `dir`, or null if it does not resolve.
 *
 *  Uses `createRequire` rather than `import.meta.resolve`: the latter is
 *  undefined on Node before 18.19/20.6 and under vite-node's SSR transform,
 *  where an optional-chained call silently succeeds and every probe answers
 *  "installed". `createRequire().resolve` exists everywhere and throws. */
function resolveFrom(dir: string, specifier: string): string | null {
  try {
    return createRequire(pathToFileURL(join(dir, 'noop.js'))).resolve(specifier);
  } catch (err) {
    if (isModuleNotFound(err)) return null;
    throw err;
  }
}

/** Packages to install for one optional capability, per install mode.
 *  `global` is a separate list because global trees do not hoist. */
export interface OptionalDepSpec {
  /** Human-readable capability name, used in the error message. */
  feature: string;
  /** Install list for a project-local Argo. */
  project: string[];
  /** Install list for a globally installed Argo. */
  global: string[];
}

// The specs below pin a major, and write it `@3` rather than `@^3`. The two
// ranges are identical to npm (node-semver normalises both to
// `>=3.0.0 <4.0.0-0`), but `^` is a glob operator under zsh's `extendedglob`,
// where the pasted command dies with `no matches found` and never reaches npm.
// These strings exist to be pasted into a shell, so they avoid the character.
// The cloud SDKs further down need no pin: their peer ranges are open-ended,
// so whatever `latest` gives satisfies them.
//
// The pin itself is what keeps one ONNX runtime in the tree. `latest` is 4.x,
// so a bare `npm i @huggingface/transformers` next to an existing kokoro-js
// re-nests its 3.x copy underneath v4: ~765 MB against ~410 MB. A user who
// installs Kokoro and later enables `tts.transcribe` reaches that by following
// the hint printed here. Everything Argo asks of the package (`pipeline`,
// `AutoTokenizer`, `MusicgenForConditionalGeneration`, word-level Whisper
// timestamps) is verified on 3.8.1. Drop the pin once kokoro-js moves to v4.
export const KOKORO_DEP: OptionalDepSpec = {
  feature: 'Kokoro local TTS',
  // Pinned to the major the peer range allows: an unpinned `npm i kokoro-js`
  // would resolve to a future v2 and fail ERESOLVE against `^1.2.1`.
  project: ['kokoro-js@1'],
  // kokoro-js keeps its own transformers copy private in a global tree.
  global: ['kokoro-js@1', '@huggingface/transformers@3'],
};

export const TRANSFORMERS_DEP: OptionalDepSpec = {
  feature: 'local Transformers.js models',
  project: ['@huggingface/transformers@3'],
  global: ['@huggingface/transformers@3'],
};

export const WHISPER_DEP: OptionalDepSpec = {
  feature: 'Whisper word-level transcription (`tts.transcribe`)',
  project: ['@huggingface/transformers@3'],
  global: ['@huggingface/transformers@3'],
};

export const MUSICGEN_DEP: OptionalDepSpec = {
  feature: 'MusicGen background music generation',
  project: ['@huggingface/transformers@3'],
  global: ['@huggingface/transformers@3'],
};

export const OPENAI_DEP: OptionalDepSpec = {
  feature: 'OpenAI TTS',
  project: ['openai'],
  global: ['openai'],
};

export const ELEVENLABS_DEP: OptionalDepSpec = {
  feature: 'ElevenLabs TTS',
  project: ['@elevenlabs/elevenlabs-js'],
  global: ['@elevenlabs/elevenlabs-js'],
};

export const GEMINI_DEP: OptionalDepSpec = {
  feature: 'Gemini TTS',
  project: ['@google/genai'],
  global: ['@google/genai'],
};

export const SARVAM_DEP: OptionalDepSpec = {
  feature: 'Sarvam TTS',
  project: ['sarvamai'],
  global: ['sarvamai'],
};

let cachedMode: InstallMode | null = null;

/** Where is this copy of Argo installed from? Cached per process.
 *
 *  npx unpacks into `~/.npm/_npx/<hash>/`, which is unambiguous. Otherwise
 *  ask the real resolver: does the user's project resolve `@argo-video/cli`
 *  to the very copy now running? If so, `npm i <engine>` lands somewhere
 *  this process can see it, which is what makes the hint correct.
 *
 *  Delegating to the resolver rather than parsing the path keeps pnpm's
 *  `.pnpm/<pkg>/node_modules/...` store, npm's nested fallback layout, and
 *  Yarn PnP working without special cases. Comparing identity rather than
 *  mere resolvability also catches running a global Argo from inside a
 *  project that happens to have its own copy. */
export function detectInstallMode(): InstallMode {
  if (cachedMode) return cachedMode;
  let selfDir: string;
  try {
    selfDir = dirname(fileURLToPath(import.meta.url));
  } catch {
    // Bundled or otherwise non-file URL. Assume the common case.
    cachedMode = 'project';
    return cachedMode;
  }
  if (selfDir.includes(`${sep}_npx${sep}`)) {
    cachedMode = 'npx';
    return cachedMode;
  }
  try {
    const selfEntry = resolveFrom(selfDir, PKG_NAME);
    if (selfEntry === null) {
      // Running from a source checkout, not from an installed tree.
      cachedMode = 'project';
      return cachedMode;
    }
    cachedMode = resolveFrom(process.cwd(), PKG_NAME) === selfEntry ? 'project' : 'global';
  } catch (err) {
    // Resolving Argo's own name can fail without Argo being absent: an
    // `exports` map with no condition matching the caller throws
    // `ERR_PACKAGE_PATH_NOT_EXPORTED`, which this package shipped once (see
    // Publishing in CLAUDE.md). Falling back beats propagating, because
    // `doctor` calls this before anything else and must still print its
    // table, and `installCommand` runs inside `importOptional`'s catch, where
    // a throw here would replace the import failure the user needs to see.
    //
    // Same boundary as `isDepInstalled`: only resolution failures recover,
    // and Node tags every one of those with a `code`. A bug in Argo must not
    // be absorbed into a confident answer about where it is installed.
    if (typeof (err as { code?: unknown } | null)?.code !== 'string') throw err;
    cachedMode = 'project';
  }
  return cachedMode;
}

/** Reset the cached mode. Tests only. */
export function resetInstallModeCache(): void {
  cachedMode = null;
}

/** The exact command to install `spec` for the current install mode. */
export function installCommand(spec: OptionalDepSpec, mode = detectInstallMode()): string {
  switch (mode) {
    case 'global':
      // One command, not several: separate global installs do not dedupe.
      return `npm i -g ${spec.global.join(' ')}`;
    case 'npx': {
      const pkgs = [PKG_NAME, ...spec.global].map((p) => `-p ${p}`).join(' ');
      return `npx ${pkgs} -- argo <command>`;
    }
    case 'project':
      return `npm i ${spec.project.join(' ')}`;
  }
}

/** True when `err` is Node's "package is not installed" failure.
 *
 *  Distinguishes a missing optional dependency from a real fault inside a
 *  dependency that *is* installed. Those must keep propagating unchanged. */
export function isModuleNotFound(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
}

/** Error explaining which optional package is missing and how to install it. */
export function missingDependencyError(spec: OptionalDepSpec, cause?: unknown): Error {
  const names = spec.project.map(bareName);
  const list = names.length === 1 ? `'${names[0]}'` : names.map((n) => `'${n}'`).join(' and ');
  const err = new Error(
    `${spec.feature} requires ${list}, which is an optional dependency and is not installed.\n` +
      `  Install it with: ${installCommand(spec)}`,
  );
  if (cause !== undefined) (err as Error & { cause?: unknown }).cause = cause;
  return err;
}

/** Dynamic-import wrapper that turns a missing optional package into an
 *  actionable error, and leaves every other failure untouched.
 *
 *  A module-not-found is not enough on its own to blame the optional
 *  package: the same code surfaces when the package is present but one of
 *  *its* dependencies fails to load. `onnxruntime-node` does exactly that,
 *  requiring a per-arch native binding at runtime, so a machine without a
 *  matching prebuilt binary would otherwise be told to install `kokoro-js`
 *  when it already has it. Confirm the package really is absent first. */
export async function importOptional<T>(load: () => Promise<T>, spec: OptionalDepSpec): Promise<T> {
  try {
    return await load();
  } catch (err) {
    if (isModuleNotFound(err) && !isDepInstalled(spec)) {
      throw missingDependencyError(spec, err);
    }
    throw err;
  }
}

/** Is the optional package for `spec` resolvable right now? Used by
 *  `argo doctor` to report engine availability without loading anything.
 *
 *  Only a genuine module-not-found means "absent". A corrupt manifest or a
 *  broken `exports` map throws a different code and must not be reported as
 *  "not installed", or the user reinstalls a package that is already there.
 *
 *  Reading this as "not known to be absent" is what makes it total. A probe
 *  can fail on its own: an interrupted `npm i` leaves a truncated
 *  `package.json` (`ERR_INVALID_PACKAGE_CONFIG`) and an `exports` map with no
 *  matching condition throws `ERR_PACKAGE_PATH_NOT_EXPORTED`. Neither may
 *  escape. `importOptional` calls this from inside a `catch`, where a throw
 *  would replace the real import failure, and `argo doctor` is the command a
 *  user runs precisely because their install is half-broken. */
export function isDepInstalled(spec: OptionalDepSpec): boolean {
  try {
    return resolveFrom(dirname(fileURLToPath(import.meta.url)), bareName(spec.project[0])) !== null;
  } catch (err) {
    // Only resolution failures recover. Node tags every one of them with a
    // `code`; a bug in Argo (a spec with an empty `project`, say) surfaces as
    // a bare TypeError and must not be answered with "installed".
    if (typeof (err as { code?: unknown } | null)?.code === 'string') return true;
    throw err;
  }
}
