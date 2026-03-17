# TTS Engines Reference

## Engine Selection

Argo supports 7 TTS engines via typed factory functions in config:

```javascript
import { defineConfig, engines } from '@argo-video/cli';

export default defineConfig({
  tts: {
    engine: engines.openai({ model: 'gpt-4o-mini-tts', instructions: 'Speak clearly and confidently.' }),
    defaultVoice: 'alloy',
  },
});
```

| Engine | Type | Install | Voices |
|--------|------|---------|--------|
| `engines.kokoro()` | local | built-in | `af_heart`, `am_michael` |
| `engines.openai()` | cloud | `npm i openai` | `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer` |
| `engines.elevenlabs()` | cloud | `npm i @elevenlabs/elevenlabs-js` | ElevenLabs voice IDs |
| `engines.gemini()` | cloud | `npm i @google/genai` | Gemini voice names |
| `engines.sarvam()` | cloud | `npm i sarvamai` | `meera` + Indian language voices |
| `engines.mlxAudio()` | local | `pip install mlx-audio` | model-dependent (Apple Silicon only) |
| `engines.transformers()` | local | built-in | any HuggingFace `text-to-speech` model |

Cloud engines read API keys from environment variables (`OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `GEMINI_API_KEY`, `SARVAM_API_KEY`) or accept `apiKey` in factory options.

Custom engines: implement the `TTSEngine` interface and pass to `tts.engine`.

### Transformers.js Engine

Works with any HuggingFace `text-to-speech` pipeline model:

```javascript
engines.transformers({ model: 'onnx-community/Supertonic-TTS-ONNX' })
```

Speaker embeddings map to the `voice` field per scene. Models outputting non-24kHz audio are automatically resampled via ffmpeg.

**Gotchas:**
- The `voice` field only accepts paths/URLs to `.bin` speaker embedding files. Engine-specific names like `af_heart` (Kokoro) are ignored with a warning.
- Default dtype is `q8` (quantized). Models without quantized weights (like Supertonic) need `dtype: 'fp32'`.
- Supertonic-TTS-2 outputs at 44.1kHz — resampling to 24kHz is handled automatically via ffmpeg.

```javascript
// Supertonic-TTS-2 example with speaker embedding
engines.transformers({
  model: 'onnx-community/Supertonic-TTS-2-ONNX',
  dtype: 'fp32',
  speakerEmbeddings: 'https://huggingface.co/onnx-community/Supertonic-TTS-2-ONNX/resolve/main/voices/F1.bin',
})
```

### OpenAI `instructions` Option

System-prompt-capable models like `gpt-4o-mini-tts` support an `instructions` field:

```javascript
engines.openai({ model: 'gpt-4o-mini-tts', instructions: 'Speak warmly like a product demo narrator.' })
```

---

## Voice Cloning (mlx-audio)

Clone your own voice from a 15-second reference clip. Local — no data leaves the machine.

```javascript
engines.mlxAudio({
  model: 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16',
  refAudio: './assets/ref-voice.wav',
  refText: 'Transcript of what I said in the reference clip.',
})
```

Qwen3-TTS produces the best clone quality. CSM is supported but lower quality.

### Helper Scripts

Use `$(npm root)/@argo-video/cli/scripts/` for npm installs, or `./scripts/` if working in the Argo repo:

- `record-voice-ref.sh assets/ref-voice.wav` — record reference clip via macOS microphone
- `voice-clone-preview.sh --ref-audio ... --voiceover demos/<name>.scenes.json --play` — batch preview cloned voice

### Full mlx-audio Options

```javascript
engines.mlxAudio({
  baseUrl: 'http://localhost:8000',  // server URL (default)
  model: 'mlx-community/Spark-TTS-0.5B-bf16',
  refAudio: './ref.wav',        // voice cloning reference
  refText: 'Transcript...',     // required with refAudio
  instruct: 'Speak warmly',    // style/emotion control
  gender: 'male',              // gender hint
  temperature: 0.7,            // sampling temperature
  topP: 0.95,                  // top-p sampling
  topK: 40,                    // top-k sampling
})
```

---

## Phonetic Spelling for TTS Pronunciation

Voiceover `text` is spoken only, never displayed — overlay text is what viewers see. Spell words phonetically in manifests to fix TTS pronunciation without affecting visuals.

| Written | Phonetic for TTS |
|---------|-----------------|
| `SaaS` | `sass` |
| `PostgreSQL` | `post-gress Q L` |
| `OAuth` | `oh-auth` |
| `API` | `A P I` |
| `kubectl` | `cube control` |
| `nginx` | `engine X` |
| `CI/CD` | `C I C D` |
| `.env` | `dot env` |

### Patterns

1. **Acronyms** — spell out with spaces: `CI/CD` → `C I C D`
2. **Portmanteaus** — hyphenate syllables: `Kubernetes` → `koo-ber-net-eez`
3. **Elongated letters** — reduce repeated chars: `IaaS` → `ee-ass`
4. **Silent/odd spellings** — write how it sounds: `sudo` → `sue-doo`

### Per-Engine Differences

This is engine-specific — when switching engines, review all voiceover text:

- **Kokoro** needs heavy phonetic help: `tee tee ess`, `A.I.`, `M.L.X.`
- **OpenAI** handles most acronyms natively — just write `TTS`, `AI`, `MLX`
- **Qwen3 (mlx-audio)** is similar to Kokoro — needs phonetic help
- **Transformers** varies by model — test pronunciation and adjust

### Text Chunking

Long voiceover text is automatically chunked at sentence boundaries (80-500 chars) with 300ms silence gaps. This applies to Kokoro and Transformers engines. No action needed — it happens transparently.
