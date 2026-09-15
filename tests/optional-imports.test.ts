import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Every `.ts` under `dir`, recursively.
 *
 *  Hand-rolled rather than `fs.globSync` (Node 22+) or `readdirSync`'s
 *  `recursive` option (Node 18.17/20.1+): this file is the only guard against
 *  an optional peer regressing to a static import, so it must not be the one
 *  thing in the suite that needs a newer Node than the package supports. On
 *  Node 20 `globSync` is undefined and the file died at collection, taking all
 *  of its assertions with it while CI stayed green on 24. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) found.push(full);
  }
  return found;
}

/** Packages declared as optional peers in package.json. None may be loaded at
 *  module scope, or the whole install-footprint design collapses: a static
 *  import fails at link time and a top-level `require` at evaluation, either
 *  of which takes down every command, including ones that never touch TTS. */
const OPTIONAL_PACKAGES = [
  'kokoro-js',
  '@huggingface/transformers',
  'openai',
  '@elevenlabs/elevenlabs-js',
  '@google/genai',
  'sarvamai',
];

/** Matches every form that loads the package eagerly:
 *  `import x from 'pkg'`, `export * from 'pkg'`, the bare side-effect
 *  `import 'pkg'`, and `require('pkg')`. Dynamic `import('pkg')` has no `from`
 *  and no quote directly after `import`, so it never matches, which is what
 *  lets `importOptional(() => import('pkg'), SPEC)` through.
 *
 *  Subpaths count. `import { OpenAI } from 'openai/index.mjs'` links at load
 *  time exactly like the bare specifier does, and would otherwise slip past
 *  the one test standing between a regression and a broken install.
 *
 *  `require.resolve('pkg')` is deliberately NOT matched: resolving asks
 *  whether a package is there without loading it, which is exactly what
 *  `isDepInstalled` does. */
function eagerLoadOf(pkg: string): RegExp {
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?:\\bfrom\\s*|^\\s*import\\s*|\\brequire\\s*\\(\\s*)['"]${escaped}(?:/[^'"]*)?['"]`,
  );
}

/** `createRequire(url)('pkg')` loads just as eagerly as `require('pkg')`.
 *  Rewriting the call to `require` lets one pattern cover both instead of
 *  growing `eagerLoadOf` into something nobody can read.
 *
 *  Known gap: `const r = createRequire(url); r('pkg')` splits the call from
 *  the specifier across statements, and the binding can be named anything, so
 *  no line-based scan can see it. That two-step form is what `src/cli.ts` and
 *  `src/overlays/gsap-runtime.ts` already use, so treat this as defence in
 *  depth rather than proof. */
const CREATE_REQUIRE = /createRequire\s*\([^)]*\)/g;

/** `import type` / `export type` is erased before it reaches the runtime, so
 *  it cannot break an install that lacks the package.
 *
 *  Stripped from the whole source rather than line by line: a wrapped type
 *  import leaves its `from` clause on a later line, which no per-line check
 *  can attribute back to the `type` keyword that opened the statement. */
const TYPE_ONLY = /^[ \t]*(?:import|export)\s+type\b[\s\S]*?from\s*['"][^'"]*['"]/gm;

describe('optional packages are never loaded at module scope', () => {
  // All six are devDependencies, so they resolve during tests. Nothing else in
  // the suite can notice a regression from `await import(x)` back to a
  // top-level `import x from`. This test is the only guard.
  const files = sourceFiles(SRC);

  it('finds source files to scan', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const pkg of OPTIONAL_PACKAGES) {
    it(`no eager load of ${pkg}`, () => {
      const pattern = eagerLoadOf(pkg);
      const offenders = files
        .filter((file) => {
          const src = readFileSync(file, 'utf-8')
            .replace(TYPE_ONLY, '')
            .replace(CREATE_REQUIRE, 'require');
          return src.split('\n').some((line) => {
            const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
            return pattern.test(code);
          });
        })
        .map((f) => relative(SRC, f));
      expect(offenders).toEqual([]);
    });
  }
});
