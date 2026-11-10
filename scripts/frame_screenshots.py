"""
Frame Screenshots

Gives documentation screenshots a little room around the edges (in the page color behind them),
a gray border that shows on light and dark pages, and rounded corners (transparent outside).
Images that already have transparent corners are left alone, so it is safe to run on a whole
folder again; frame the original screenshots, not framed ones.

    python scripts/frame_screenshots.py ../financial_planner.wiki/assets/*.png --skip app-icon.png

License: BSD 3-Clause
"""
#
# Imports
#
import argparse
import sys
from pathlib import Path

from PIL import Image, ImageDraw

#
# CONSTANTS
#
RADIUS: int = 10
PADDING: int = 12
BORDER_WIDTH: int = 2
BORDER: tuple[int, int, int, int] = (140, 148, 158, 255)
PAGE: tuple[int, int, int, int] = (243, 245, 244, 255)
DARK: int = 200
SCALE: int = 4


#
# PUBLIC
#
def is_framed(img: Image.Image) -> bool:
    """Whether an image already has a transparent top-left corner.

    Args:
        img: The image.

    Returns:
        True if the corner pixel is fully transparent.
    """
    return img.mode == 'RGBA' and img.getpixel((0, 0))[3] == 0


def page_color(img: Image.Image) -> tuple[int, int, int, int]:
    """The page color behind a screenshot: its top-left corner, which is outside the rounded
    corner of the card or section shot. A dark corner (a dialog's backdrop) gives the app's page
    color instead.

    Args:
        img: The image.

    Returns:
        An RGBA color.
    """
    r, g, b, *_ = img.convert('RGBA').getpixel((0, 0))
    return (r, g, b, 255) if (r + g + b) / 3 >= DARK else PAGE


def clear_dark_corners(img: Image.Image, color: tuple[int, int, int, int]) -> Image.Image:
    """Paints a dialog's dark backdrop showing at its rounded corners in the page color.

    Args:
        img: An RGBA image (changed in place).
        color: The page color.

    Returns:
        The same image.
    """
    w, h = img.size
    for xy in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        r, g, b, *_ = img.getpixel(xy)
        if (r + g + b) / 3 < DARK:
            ImageDraw.floodfill(img, xy, color, thresh=24)
    return img


def frame(img: Image.Image, radius: int = RADIUS, padding: int = PADDING,
          width: int = BORDER_WIDTH) -> Image.Image:
    """Pads an image in the page color, draws a gray border and rounds the corners.

    Args:
        img: The image.
        radius: Corner radius in pixels.
        padding: Room added on every side, in pixels.
        width: Border width in pixels.

    Returns:
        A new RGBA image, 2 × (padding + width) larger each way.
    """
    page = page_color(img)
    inner = clear_dark_corners(img.convert('RGBA'), page)
    edge = padding + width
    out = Image.new('RGBA', (inner.width + 2 * edge, inner.height + 2 * edge), page)
    out.paste(inner, (edge, edge))
    w, h = out.size
    big = (w * SCALE, h * SCALE)
    box = (0, 0, big[0] - 1, big[1] - 1)
    mask = Image.new('L', big, 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius * SCALE, fill=255)
    out.putalpha(mask.resize((w, h), Image.LANCZOS))
    line = Image.new('RGBA', big, (0, 0, 0, 0))
    ImageDraw.Draw(line).rounded_rectangle(box, radius * SCALE, outline=BORDER,
                                           width=width * SCALE)
    return Image.alpha_composite(out, line.resize((w, h), Image.LANCZOS))


def main(argv: list[str] | None = None) -> int:
    """Frames each image in place.

    Args:
        argv: Command-line arguments (default: sys.argv).

    Returns:
        Exit code.
    """
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[1],
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('images', nargs='+', type=Path, help='PNG files to frame in place')
    parser.add_argument('--skip', nargs='*', default=[], help='file names to leave alone (icons)')
    parser.add_argument('--radius', type=int, default=RADIUS, help='corner radius in pixels')
    parser.add_argument('--padding', type=int, default=PADDING, help='room around the edges')
    parser.add_argument('--width', type=int, default=BORDER_WIDTH, help='border width')
    args = parser.parse_args(argv)
    for path in args.images:
        if path.name in args.skip:
            continue
        try:
            with Image.open(path) as img:
                if is_framed(img):
                    print(f'already framed: {path.name}')
                    continue
                framed = frame(img, args.radius, args.padding, args.width)
        except OSError as err:
            print(f'skipped {path}: {err}', file=sys.stderr)
            continue
        framed.save(path, optimize=True)
        print(f'framed: {path.name}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
