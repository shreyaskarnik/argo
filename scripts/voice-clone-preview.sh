#!/usr/bin/env bash
#
# Quick voice cloning preview — send voiceover text to mlx-audio server
# and get back individual clips + an optional joined clip.
#
# Usage:
#   ./scripts/voice-clone-preview.sh \
#     --ref-audio ./assets/ref-voice.wav \
#     --ref-text "Hi, my name is Shreyas. I build developer tools." \
#     --voiceover demos/showcase.voiceover.json
#
#   # Single line of text (no manifest):
#   ./scripts/voice-clone-preview.sh \
#     --ref-audio ./assets/ref-voice.wav \
#     --ref-text "Hi, my name is Shreyas." \
#     --text "Welcome to the demo."
#
# Options:
#   --ref-audio   PATH   Reference voice WAV (required)
#   --ref-text    TEXT   Transcript of reference audio (required)
#   --voiceover   PATH   Voiceover JSON manifest (array of {scene, text, speed?, voice?})
#   --text        TEXT   Single text to synthesize (alternative to --voiceover)
#   --model       ID     Model ID (default: mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16)
#   --server      URL    Server URL (default: http://localhost:8000)
#   --out-dir     PATH   Output directory (default: ./voice-preview)
#   --join               Also produce a single joined clip
#   --play               Play the output when done (requires ffplay)
#   --voice       NAME   Default voice (default: af_heart)
#
set -euo pipefail

# Defaults
MODEL="mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16"
SERVER="http://localhost:8000"
OUT_DIR="./voice-preview"
REF_AUDIO=""
REF_TEXT=""
VOICEOVER=""
SINGLE_TEXT=""
JOIN=false
PLAY=false
VOICE="af_heart"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref-audio)  REF_AUDIO="$2"; shift 2;;
    --ref-text)   REF_TEXT="$2"; shift 2;;
    --voiceover)  VOICEOVER="$2"; shift 2;;
    --text)       SINGLE_TEXT="$2"; shift 2;;
    --model)      MODEL="$2"; shift 2;;
    --server)     SERVER="$2"; shift 2;;
    --out-dir)    OUT_DIR="$2"; shift 2;;
    --voice)      VOICE="$2"; shift 2;;
    --join)       JOIN=true; shift;;
    --play)       PLAY=true; shift;;
    -h|--help)
      sed -n '2,/^set /{ /^#/s/^# \?//p }' "$0"
      exit 0;;
    *) echo "Unknown option: $1"; exit 1;;
  esac
done

if [[ -z "$REF_AUDIO" || -z "$REF_TEXT" ]]; then
  echo "Error: --ref-audio and --ref-text are required."
  exit 1
fi

if [[ -z "$VOICEOVER" && -z "$SINGLE_TEXT" ]]; then
  echo "Error: provide --voiceover <manifest.json> or --text <string>."
  exit 1
fi

# Check server is running
if ! curl -sf "$SERVER/v1/audio/speech" -o /dev/null -X POST \
  -H "Content-Type: application/json" \
  -d '{"model":"test","input":"test"}' 2>/dev/null; then
  # It's OK if the request fails with a model error — server is up
  if ! curl -sf --connect-timeout 3 "$SERVER" -o /dev/null 2>/dev/null && \
     ! curl -sf --connect-timeout 3 "$SERVER/docs" -o /dev/null 2>/dev/null; then
    echo "Warning: mlx-audio server may not be running at $SERVER"
    echo "Start it with: python3 -m mlx_audio.server --model $MODEL"
    echo ""
  fi
fi

mkdir -p "$OUT_DIR"

# Build the list of clips to generate
# Format: index|scene_name|text|speed|voice
CLIPS_LIST=$(mktemp)
trap 'rm -f "$CLIPS_LIST"' EXIT

if [[ -n "$SINGLE_TEXT" ]]; then
  echo "0|single|$SINGLE_TEXT|1.0|$VOICE" > "$CLIPS_LIST"
else
  # Parse voiceover JSON with python (available on macOS)
  python3 -c "
import json, sys
with open('$VOICEOVER') as f:
    scenes = json.load(f)
for i, s in enumerate(scenes):
    scene = s.get('scene', f'scene-{i}')
    text = s['text'].replace('|', ' ')
    speed = s.get('speed', 1.0)
    voice = s.get('voice', '$VOICE')
    print(f'{i}|{scene}|{text}|{speed}|{voice}')
" > "$CLIPS_LIST"
fi

TOTAL=$(wc -l < "$CLIPS_LIST" | tr -d ' ')
echo "Generating $TOTAL clip(s) via $SERVER"
echo "Model: $MODEL"
echo "Ref audio: $REF_AUDIO"
echo "Output: $OUT_DIR/"
echo ""

GENERATED_FILES=()
IDX=0

while IFS='|' read -r _ SCENE TEXT SPEED CLIP_VOICE; do
  IDX=$((IDX + 1))
  OUTFILE="$OUT_DIR/$(printf '%02d' "$IDX")-${SCENE}.wav"

  printf "  [%d/%d] %s ... " "$IDX" "$TOTAL" "$SCENE"

  # Build JSON payload
  PAYLOAD=$(python3 -c "
import json
p = {
    'model': '$MODEL',
    'input': $(python3 -c "import json; print(json.dumps('$TEXT'))"),
    'voice': '$CLIP_VOICE',
    'speed': $SPEED,
    'ref_audio': '$REF_AUDIO',
    'ref_text': $(python3 -c "import json; print(json.dumps('$REF_TEXT'))"),
}
print(json.dumps(p))
")

  HTTP_CODE=$(curl -sf -w '%{http_code}' -o "$OUTFILE.raw" \
    -X POST "$SERVER/v1/audio/speech" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" 2>/dev/null || echo "000")

  if [[ "$HTTP_CODE" == "200" ]]; then
    # Convert to consistent WAV format
    ffmpeg -y -i "$OUTFILE.raw" \
      -ar 24000 -ac 1 -acodec pcm_s16le \
      "$OUTFILE" 2>/dev/null
    rm -f "$OUTFILE.raw"

    DURATION=$(ffprobe -v error -show_entries format=duration \
      -of csv=p=0 "$OUTFILE" 2>/dev/null)
    printf "done (%.1fs)\n" "$DURATION"
    GENERATED_FILES+=("$OUTFILE")
  else
    rm -f "$OUTFILE.raw"
    printf "FAILED (HTTP %s)\n" "$HTTP_CODE"
  fi
done < "$CLIPS_LIST"

echo ""

# Join clips if requested
if $JOIN && [[ ${#GENERATED_FILES[@]} -gt 1 ]]; then
  JOINED="$OUT_DIR/joined.wav"
  CONCAT_LIST=$(mktemp)
  for f in "${GENERATED_FILES[@]}"; do
    echo "file '$(realpath "$f")'" >> "$CONCAT_LIST"
  done

  ffmpeg -y -f concat -safe 0 -i "$CONCAT_LIST" \
    -ar 24000 -ac 1 -acodec pcm_s16le \
    "$JOINED" 2>/dev/null
  rm -f "$CONCAT_LIST"

  TOTAL_DURATION=$(ffprobe -v error -show_entries format=duration \
    -of csv=p=0 "$JOINED" 2>/dev/null)
  echo "Joined clip: $JOINED (${TOTAL_DURATION}s)"
  echo ""

  if $PLAY; then
    echo "Playing joined clip..."
    ffplay -autoexit -nodisp "$JOINED" 2>/dev/null
  fi
elif $PLAY && [[ ${#GENERATED_FILES[@]} -gt 0 ]]; then
  LAST_IDX=$(( ${#GENERATED_FILES[@]} - 1 ))
  PLAY_FILE="${GENERATED_FILES[$LAST_IDX]}"
  echo "Playing: $PLAY_FILE"
  ffplay -autoexit -nodisp "$PLAY_FILE" 2>/dev/null
fi

echo "Done! Clips saved to $OUT_DIR/"
