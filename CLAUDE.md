# CLAUDE.md

## About
Argo turns Playwright demo scripts into polished product demo videos with AI voiceover. Users write a Playwright test, add a voiceover JSON manifest, and run `argo pipeline` to get an MP4 with screen recording, overlays, and narration — all locally, no cloud services required.

## Build & Test
- `npm run build` — TypeScript compilation
- `npm test` — runs vitest
- E2E tests require Playwright browsers: `npx playwright install chromium`

## Publishing
- Package: `@argo-video/cli` (npm org: `@argo-video`)
- Publishing is automated via GitHub Actions OIDC trusted publishing (no NPM_TOKEN needed)
- To release: bump version in package.json, tag, create GitHub release → workflow handles the rest

## Git Conventions
- `demos/` directory is gitignored — use `git add -f demos/<file>` for demo source files
- GPG signing may fail in CLI environments — use `git -c commit.gpgsign=false commit` if needed

## Argo Pipeline
- Order: TTS → Record → Align → Export (not Record first)
- `argo tts generate` takes a file path (`demos/name.voiceover.json`), not a bare demo name
- `argo record/export/pipeline` take bare demo names (e.g., `argo pipeline example`)

## Demo Authoring
- Demo scripts: `demos/<name>.demo.ts`
- Voiceover manifests: `demos/<name>.voiceover.json`
- Overlay manifests: `demos/<name>.overlays.json`
- TTS engine: Kokoro (local, no API keys). Voices: `af_heart` (female default), `am_michael` (male)
- Long demos need `test.setTimeout()` — Playwright default is 30s
