#!/usr/bin/env node
/**
 * Copy the GLSL shader sources into dist/.
 *
 * `tsc` only emits what it compiles, so the .glsl files shader-render reads at
 * runtime have to be copied separately.
 *
 * This is a script rather than an inline npm command because `prepare` runs it
 * on every install, including on Windows, where npm invokes lifecycle scripts
 * through cmd.exe. The previous `mkdir -p ... && cp src/**\/*.glsl` is
 * POSIX-only: cmd.exe has no `cp`, and `mkdir -p` there creates a directory
 * literally named `-p`. An inline `node -e` would work but reintroduces the
 * same hazard one level down, since quoting differs between cmd.exe and sh.
 */
import { mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(root, 'src', 'transitions', 'shaders');
const to = join(root, 'dist', 'transitions', 'shaders');

mkdirSync(to, { recursive: true });

// Only .glsl — the directory also holds index.ts and a README, which tsc
// handles or which do not belong in dist at all.
const shaders = readdirSync(from).filter(name => name.endsWith('.glsl'));
for (const name of shaders) copyFileSync(join(from, name), join(to, name));

console.log(`copy-assets: ${shaders.length} shaders -> dist/transitions/shaders`);
