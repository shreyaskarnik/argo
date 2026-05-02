#!/usr/bin/env python3
"""
Verify ci-smoke output mp4. Asserts:
  - output exists and is valid mp4
  - dimensions are 1920x1080 (catches dsf-clamp regressions)
  - duration is in expected window
  - midpoint frame's bottom-right quadrant is not near-gray
    (catches frame-in-frame regressions where a non-chromium browser
    rendered the page at 1x into a 2x screencast canvas)

Usage: python3 scripts/verify-ci-smoke.py videos/ci-smoke.mp4
"""

import subprocess
import sys
from pathlib import Path

EXPECTED_W, EXPECTED_H = 1920, 1080
MIN_DURATION_S, MAX_DURATION_S = 5, 20


def ffprobe(*args: str) -> str:
    return subprocess.check_output(['ffprobe', '-v', 'error', *args]).decode().strip()


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit('Usage: verify-ci-smoke.py <mp4>')
    mp4 = Path(sys.argv[1])
    if not mp4.exists():
        sys.exit(f'missing output: {mp4}')

    dims_csv = ffprobe('-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', str(mp4))
    w, h = (int(x) for x in dims_csv.split(','))
    if (w, h) != (EXPECTED_W, EXPECTED_H):
        sys.exit(f'dimensions {w}x{h} != {EXPECTED_W}x{EXPECTED_H}')

    duration = float(ffprobe('-show_entries', 'format=duration', '-of', 'csv=p=0', str(mp4)))
    if not MIN_DURATION_S <= duration <= MAX_DURATION_S:
        sys.exit(f'duration {duration:.1f}s outside [{MIN_DURATION_S}, {MAX_DURATION_S}]')

    sample_path = Path('/tmp/ci-smoke-sample.png')
    subprocess.check_call(
        ['ffmpeg', '-y', '-ss', f'{duration / 2:.2f}', '-i', str(mp4), '-frames:v', '1', str(sample_path)],
        stderr=subprocess.DEVNULL,
    )

    from PIL import Image
    img = Image.open(sample_path).convert('RGB')
    samples = {
        'top-left': img.getpixel((w // 4, h // 4)),
        'top-right': img.getpixel((3 * w // 4, h // 4)),
        'bottom-left': img.getpixel((w // 4, 3 * h // 4)),
        'bottom-right': img.getpixel((3 * w // 4, 3 * h // 4)),
        'center': img.getpixel((w // 2, h // 2)),
    }
    print('pixel samples:')
    for name, rgb in samples.items():
        print(f'  {name:13s}: {rgb}')

    # Bottom-right should be inside the rendered scene background, not gray padding.
    # The three scenes use saturated dark colors (#1e3a8a, #7c2d12, #14532d) — the
    # max channel deviation from grey is at least ~70. Padding gray pixels stay
    # within ~10 of (128,128,128).
    br = samples['bottom-right']
    gray_distance = sum(abs(c - 128) for c in br)
    if gray_distance < 30:
        sys.exit(f'bottom-right {br} too close to gray (distance={gray_distance}) — frame-in-frame regression?')

    print(f'OK: {w}x{h}, {duration:.1f}s, br_gray_distance={gray_distance}')


if __name__ == '__main__':
    main()
