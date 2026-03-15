#!/usr/bin/env bash
#
# Record and process a voice reference clip for mlx-audio voice cloning.
# Usage: ./scripts/record-voice-ref.sh [output_path]
#
# Requirements: ffmpeg (brew install ffmpeg), macOS with built-in mic
#
set -euo pipefail

OUTPUT="${1:-assets/ref-voice.wav}"
RAW_FILE=$(mktemp /tmp/voice-ref-raw.XXXXXX.wav)

# Suggested text — covers a wide range of English phonemes
cat <<'PROMPT'
╔══════════════════════════════════════════════════════════════════╗
║  Voice Reference Recording                                      ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                  ║
║  Read the following text naturally, at your demo narration pace: ║
║                                                                  ║
║  "Hi, my name is [YOUR NAME]. I build developer tools and love   ║
║   creating great product demos. The quick brown fox jumps over   ║
║   the lazy dog. Pack my box with five dozen liquor jugs."        ║
║                                                                  ║
║  Tips:                                                           ║
║   • Sit ~6 inches from the mic                                   ║
║   • Use a quiet room (close windows, turn off fans)              ║
║   • Speak clearly at your natural pace                           ║
║   • Aim for 5–15 seconds                                         ║
║                                                                  ║
╚══════════════════════════════════════════════════════════════════╝

PROMPT

echo "Press ENTER to start recording (Ctrl+C to cancel)..."
read -r

echo "🎙  Recording... Press Ctrl+C when done."

# Record using macOS Core Audio (avfoundation) via ffmpeg
# Uses the default input device (built-in mic or whatever is selected in
# System Settings > Sound > Input)
ffmpeg -y -f avfoundation -i ":default" \
  -acodec pcm_s16le -ar 44100 -ac 1 \
  "$RAW_FILE" 2>/dev/null || true

echo ""
echo "Processing audio..."

# Get duration
DURATION=$(ffprobe -v error -show_entries format=duration \
  -of csv=p=0 "$RAW_FILE" 2>/dev/null || echo "0")

if [ "$DURATION" = "0" ] || [ "$(echo "$DURATION < 2" | bc -l 2>/dev/null || echo 0)" = "1" ]; then
  echo "Error: Recording too short or failed. Try again."
  rm -f "$RAW_FILE"
  exit 1
fi

# Create output directory if needed
mkdir -p "$(dirname "$OUTPUT")"

# Process: mono, 24kHz, noise-reduced, normalized
ffmpeg -y -i "$RAW_FILE" \
  -af "highpass=f=80,lowpass=f=12000,afftdn=nf=-25,loudnorm=I=-16:TP=-1.5:LRA=11" \
  -ar 24000 -ac 1 -acodec pcm_s16le \
  "$OUTPUT" 2>/dev/null

rm -f "$RAW_FILE"

FINAL_DURATION=$(ffprobe -v error -show_entries format=duration \
  -of csv=p=0 "$OUTPUT" 2>/dev/null)

echo ""
echo "Done! Saved to: $OUTPUT (${FINAL_DURATION}s)"
echo ""
echo "Next steps:"
echo "  1. Listen: ffplay $OUTPUT"
echo "  2. Add to your argo config:"
echo ""
echo "     tts: {"
echo "       engine: engines.mlxAudio({"
echo "         model: 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16',"
echo "         refAudio: './$OUTPUT',"
echo "         refText: 'YOUR EXACT TRANSCRIPT HERE',"
echo "       }),"
echo "     }"
