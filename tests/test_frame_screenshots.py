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
def test_frame_rounds_corners_and_draws_a_border(tmp_path: Path) -> None:
    fs = _load()
    path = tmp_path / 'shot.png'
    Image.new('RGB', (120, 80), (255, 255, 255)).save(path)
    assert fs.main([str(path)]) == 0
    img = Image.open(path)
    assert img.mode == 'RGBA' and img.size == (120, 80)
    assert img.getpixel((0, 0))[3] == 0                       # corner is transparent
    assert img.getpixel((60, 40)) == (255, 255, 255, 255)     # middle unchanged
    r, g, b, a = img.getpixel((60, 0))                        # top edge is the gray border
    assert a == 255 and r < 255 and abs(r - 208) < 30
    assert fs.is_framed(img)


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
