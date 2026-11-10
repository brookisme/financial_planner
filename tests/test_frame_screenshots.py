"""
Tests for scripts/frame_screenshots.py.

License: BSD 3-Clause
"""
#
# Imports
#
import importlib.util
import sys
from pathlib import Path
from types import ModuleType

from PIL import Image

#
# CONSTANTS
#
SCRIPT: Path = Path(__file__).resolve().parents[1] / 'scripts' / 'frame_screenshots.py'


#
# PUBLIC
#
def test_frame_pads_rounds_corners_and_draws_a_border(tmp_path: Path) -> None:
    fs = _load()
    path = tmp_path / 'shot.png'
    img = Image.new('RGB', (120, 80), (240, 240, 240))           # page color in the corners
    img.paste((255, 255, 255), (10, 10, 110, 70))                # a white card
    img.save(path)
    assert fs.main([str(path)]) == 0
    out = Image.open(path)
    edge = fs.PADDING + fs.BORDER_WIDTH
    assert out.mode == 'RGBA' and out.size == (120 + 2 * edge, 80 + 2 * edge)
    assert out.getpixel((0, 0))[3] == 0                           # corner is transparent
    assert out.getpixel((60 + edge, 40 + edge)) == (255, 255, 255, 255)   # card unchanged
    assert out.getpixel((60, fs.BORDER_WIDTH + 2)) == (240, 240, 240, 255)  # padded in page color
    assert all(abs(a - b) < 8 for a, b in zip(out.getpixel((60, 0)), fs.BORDER))   # gray border
    assert fs.is_framed(out)


def test_frame_clears_a_dialog_backdrop() -> None:
    fs = _load()
    img = Image.new('RGB', (60, 60), (130, 130, 130))             # dark backdrop corners
    img.paste((255, 255, 255), (3, 3, 57, 57))
    out = fs.frame(img)
    edge = fs.PADDING + fs.BORDER_WIDTH
    assert out.getpixel((edge, edge)) == fs.PAGE                 # backdrop painted page color


def test_frame_skips_framed_images_and_named_files(tmp_path: Path, capsys) -> None:
    fs = _load()
    shot, icon = tmp_path / 'shot.png', tmp_path / 'icon.png'
    for p in (shot, icon):
        Image.new('RGB', (40, 40), (10, 20, 30)).save(p)
    fs.main([str(shot), str(icon), '--skip', 'icon.png'])
    before = shot.read_bytes()
    fs.main([str(shot)])
    assert shot.read_bytes() == before
    assert 'already framed' in capsys.readouterr().out
    assert Image.open(icon).mode == 'RGB'


#
# INTERNAL
#
def _load() -> ModuleType:
    """Import the script as a module."""
    spec = importlib.util.spec_from_file_location('frame_screenshots', SCRIPT)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules['frame_screenshots'] = mod
    spec.loader.exec_module(mod)
    return mod
