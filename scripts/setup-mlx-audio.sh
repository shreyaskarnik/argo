#!/usr/bin/env bash
#
# Set up mlx-audio with all dependencies for Argo voice cloning.
# Usage: ./scripts/setup-mlx-audio.sh
#
# Creates a .venv in the project root with mlx-audio and its
# transitive deps that aren't auto-installed.
#
set -euo pipefail

VENV_DIR="${1:-.venv}"

echo "╔══════════════════════════════════════════════╗"
echo "║  Argo — mlx-audio setup (Apple Silicon)      ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# Check for uv
if ! command -v uv &>/dev/null; then
  echo "✗ uv not found. Install it: curl -LsSf https://astral.sh/uv/install.sh | sh"
  exit 1
fi

# Check for Apple Silicon
if [[ "$(uname -m)" != "arm64" ]]; then
  echo "! Warning: mlx-audio is optimized for Apple Silicon (arm64)."
  echo "  Current arch: $(uname -m). Performance may be poor."
fi

# Create venv
echo "★ Creating venv at ${VENV_DIR}..."
uv venv "$VENV_DIR"

# Install mlx-audio + missing transitive deps
echo "★ Installing mlx-audio..."
uv pip install -p "$VENV_DIR" mlx-audio

echo "★ Installing missing transitive dependencies..."
uv pip install -p "$VENV_DIR" "misaki[en]" num2words pip

# setuptools < 70 needed for webrtcvad's pkg_resources import
echo "★ Installing setuptools (< 70 for pkg_resources compat)..."
uv pip install -p "$VENV_DIR" "setuptools<70"

# Server deps (for OpenAI-compatible HTTP API)
echo "★ Installing server dependencies..."
uv pip install -p "$VENV_DIR" uvicorn fastapi python-multipart webrtcvad

echo ""
echo "✓ Done! mlx-audio installed at ${VENV_DIR}"
echo ""
echo "Usage:"
echo "  # Start the TTS server"
echo "  ${VENV_DIR}/bin/python3 -m mlx_audio.server --port 8000"
echo ""
echo "  # Record a voice reference clip"
echo "  ./scripts/record-voice-ref.sh assets/ref-voice.wav"
echo ""
echo "  # Preview cloned voice"
echo "  ./scripts/voice-clone-preview.sh \\"
echo "    --ref-audio assets/ref-voice.wav \\"
echo "    --ref-text 'Your transcript here.' \\"
echo "    --voiceover demos/showcase.voiceover.json --play"
echo ""
echo "  # Use in argo config"
echo "  engines.mlxAudio({ model: 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-bf16' })"
