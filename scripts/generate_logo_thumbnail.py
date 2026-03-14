from __future__ import annotations

from pathlib import Path
import random

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
OUTPUT_PATH = ASSETS / "logo-thumb.png"
SOURCE_MARK_PATH = ASSETS / "logo-mark-source.png"

WIDTH = 1920
HEIGHT = 1080

MONO_FONT = "/System/Library/Fonts/SFNSMono.ttf"
DISPLAY_BOLD = "/Library/Fonts/SF-Compact-Display-Bold.otf"


def load_font(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size=size)


def normalize_mark() -> Image.Image:
    if SOURCE_MARK_PATH.exists():
        return Image.open(SOURCE_MARK_PATH).convert("RGBA")

    original = Image.open(OUTPUT_PATH).convert("RGBA")
    mark = Image.new("RGBA", original.size, (0, 0, 0, 0))
    in_px = original.load()
    out_px = mark.load()

    for y in range(original.height):
        for x in range(original.width):
            r, g, b, _ = in_px[x, y]
            if b > 150 and g > 110 and r < 140:
                out_px[x, y] = (107, 180, 255, 255)

    bbox = mark.getbbox()
    if bbox is None:
        raise RuntimeError("Could not isolate source logo mark")

    cropped = mark.crop(bbox)
    cropped.save(SOURCE_MARK_PATH)
    return cropped


def lerp(a: int, b: int, t: float) -> int:
    return int(a + (b - a) * t)


def make_background() -> Image.Image:
    image = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 255))
    px = image.load()

    top_left = (8, 10, 18)
    bottom_right = (18, 22, 37)
    top_right = (12, 14, 26)

    for y in range(HEIGHT):
        ty = y / (HEIGHT - 1)
        for x in range(WIDTH):
            tx = x / (WIDTH - 1)
            r = lerp(lerp(top_left[0], top_right[0], tx), bottom_right[0], ty)
            g = lerp(lerp(top_left[1], top_right[1], tx), bottom_right[1], ty)
            b = lerp(lerp(top_left[2], top_right[2], tx), bottom_right[2], ty)
            px[x, y] = (r, g, b, 255)

    return image


def add_radial_glow(base: Image.Image, center: tuple[int, int], radius: int, color: tuple[int, int, int], alpha: int, blur: int) -> None:
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    x, y = center
    draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=color + (alpha,))
    layer = layer.filter(ImageFilter.GaussianBlur(blur))
    base.alpha_composite(layer)


def add_grid(base: Image.Image) -> None:
    grid = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(grid)

    for x in range(120, WIDTH, 96):
        draw.line((x, 0, x, HEIGHT), fill=(92, 126, 188, 14), width=1)
    for y in range(96, HEIGHT, 96):
        draw.line((0, y, WIDTH, y), fill=(92, 126, 188, 10), width=1)

    random.seed(7)
    for _ in range(240):
        x = random.randint(0, WIDTH - 1)
        y = random.randint(0, HEIGHT - 1)
        draw.point((x, y), fill=(160, 185, 255, random.randint(10, 28)))

    base.alpha_composite(grid)


def draw_mark(base: Image.Image, mark: Image.Image) -> None:
    mark = mark.resize((1440, int(mark.height * (1440 / mark.width))), Image.Resampling.LANCZOS)

    glow = Image.new("RGBA", base.size, (0, 0, 0, 0))
    glow_mark = mark.copy()
    glow_mark = glow_mark.filter(ImageFilter.GaussianBlur(14))
    gx = (WIDTH - glow_mark.width) // 2
    gy = 200
    glow.alpha_composite(glow_mark, (gx, gy))

    tint = Image.new("RGBA", base.size, (0, 0, 0, 0))
    tint_draw = ImageDraw.Draw(tint)
    tint_draw.ellipse((420, 220, 1500, 760), fill=(71, 136, 255, 30))
    tint = tint.filter(ImageFilter.GaussianBlur(54))

    base.alpha_composite(tint)
    base.alpha_composite(glow, (0, 0))

    mark_shadow = Image.new("RGBA", base.size, (0, 0, 0, 0))
    shadow = mark.copy().filter(ImageFilter.GaussianBlur(18))
    mark_shadow.alpha_composite(shadow, (gx, gy + 8))
    base.alpha_composite(mark_shadow)
    base.alpha_composite(mark, (gx, gy))


def draw_command_card(base: Image.Image) -> None:
    card = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(card)

    x0, y0, x1, y1 = 500, 760, 1420, 892
    shadow = Image.new("RGBA", base.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((x0, y0 + 18, x1, y1 + 18), radius=34, fill=(0, 0, 0, 120))
    shadow = shadow.filter(ImageFilter.GaussianBlur(24))
    base.alpha_composite(shadow)

    draw.rounded_rectangle((x0, y0, x1, y1), radius=34, fill=(14, 18, 30, 228), outline=(97, 127, 183, 88), width=2)
    draw.rounded_rectangle((x0 + 2, y0 + 2, x1 - 2, y0 + 38), radius=32, fill=(18, 23, 38, 245))

    button_y = y0 + 20
    for idx, color in enumerate(((255, 95, 86), (255, 189, 46), (39, 201, 63))):
        bx = x0 + 30 + idx * 22
        draw.ellipse((bx, button_y, bx + 12, button_y + 12), fill=color)

    mono = load_font(MONO_FONT, 40)
    small = load_font(MONO_FONT, 24)

    prompt_y = y0 + 64
    draw.text((x0 + 34, prompt_y), "$", font=mono, fill=(123, 217, 129))
    draw.text((x0 + 72, prompt_y), "npx argo", font=mono, fill=(110, 187, 255))
    draw.text((x0 + 330, prompt_y), "pipeline", font=mono, fill=(233, 239, 252))
    draw.text((x0 + 566, prompt_y), "showcase", font=mono, fill=(169, 146, 255))

    note = "local-first  •  webkit-friendly  •  retina-ready"
    note_box = draw.textbbox((0, 0), note, font=small)
    note_x = (WIDTH - (note_box[2] - note_box[0])) / 2
    draw.text((note_x, y1 + 24), note, font=small, fill=(100, 121, 160))

    base.alpha_composite(card)


def main() -> None:
    ASSETS.mkdir(exist_ok=True)
    mark = normalize_mark()
    image = make_background()
    add_radial_glow(image, (WIDTH // 2, 420), 420, (48, 99, 235), 48, 96)
    add_radial_glow(image, (1470, 210), 220, (41, 91, 235), 42, 84)
    add_radial_glow(image, (360, 910), 300, (43, 74, 170), 34, 92)
    add_grid(image)
    draw_mark(image, mark)
    draw_command_card(image)
    image.convert("RGB").save(OUTPUT_PATH, quality=95)


if __name__ == "__main__":
    main()
