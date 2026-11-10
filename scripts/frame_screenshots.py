"""
Frame Screenshots

Gives documentation screenshots rounded corners (transparent outside, so they suit light and dark
pages) and a thin light-gray border, so they stand out from the page around them. Images that
already have transparent corners are left alone, so it is safe to run on a whole folder again.

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
RADIUS: int = 8
BORDER: tuple[int, int, int, int] = (208, 215, 222, 255)
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


def frame(img: Image.Image, radius: int = RADIUS) -> Image.Image:
    """Rounds an image's corners and draws a 1px border just inside its edge.

    Args:
        img: The image.
        radius: Corner radius in pixels.

    Returns:
        A new RGBA image of the same size.
    """
    out = img.convert('RGBA')
    w, h = out.size
    big = (w * SCALE, h * SCALE)
    box = (0, 0, big[0] - 1, big[1] - 1)
    mask = Image.new('L', big, 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius * SCALE, fill=255)
    out.putalpha(mask.resize((w, h), Image.LANCZOS))
    edge = Image.new('RGBA', big, (0, 0, 0, 0))
    ImageDraw.Draw(edge).rounded_rectangle(box, radius * SCALE, outline=BORDER, width=SCALE)
    return Image.alpha_composite(out, edge.resize((w, h), Image.LANCZOS))


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
    args = parser.parse_args(argv)
    for path in args.images:
        if path.name in args.skip:
            continue
        try:
            with Image.open(path) as img:
                if is_framed(img):
                    print(f'already framed: {path.name}')
                    continue
                framed = frame(img, args.radius)
        except OSError as err:
            print(f'skipped {path}: {err}', file=sys.stderr)
            continue
        framed.save(path, optimize=True)
        print(f'framed: {path.name}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
