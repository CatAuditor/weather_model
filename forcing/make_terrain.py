#!/usr/bin/env python3
"""Build ui/assets/terrain.png: a hillshade/elevation multiplier for the basemap.

Encodes, per 0.25° cell, a brightness multiplier m in [0.6, 1.4] as
pixel value v = m*128 (128 = neutral). The UI multiplies the land color
by m so mountain ranges read as relief in both themes.
Input: forcing/ERA5_orography.nc (static geopotential z; h = z/g).
"""
import struct
import zlib
from pathlib import Path

import netCDF4
import numpy as np

HERE = Path(__file__).resolve().parent
ds = netCDF4.Dataset(HERE / "ERA5_orography.nc")
h = np.asarray(ds.variables["z"][0], dtype=np.float64) / 9.80665  # (721,1440) metres
h = np.maximum(h, 0)

# gradients (metres per grid step; hillshade wants unitless steepness)
dzdy = np.gradient(h, axis=0)          # towards south (row index grows southward)
dzdx = np.gradient(h, axis=1)
exag = 1 / 400.0                        # vertical exaggeration for ~28 km cells
sx, sy = dzdx * exag, dzdy * exag
# light from the northwest, standard hillshade
az, zen = np.deg2rad(315), np.deg2rad(55)
slope = np.arctan(np.hypot(sx, sy))
aspect = np.arctan2(-sx, sy)
hs = np.cos(zen) * np.cos(slope) + np.sin(zen) * np.sin(slope) * np.cos(az - aspect)
hs = np.clip(hs, 0, 1)

m = 1.0 + 0.55 * (hs - hs[h > 1].mean()) - 0.12 * np.minimum(h / 4000.0, 1.0)
m = np.clip(m, 0.6, 1.4)
img = np.round(m * 128).astype(np.uint8)


def write_png_gray(path, img):
    hh, ww = img.shape
    raw = b"".join(b"\x00" + img[r].tobytes() for r in range(hh))

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))

    ihdr = struct.pack(">IIBBBBB", ww, hh, 8, 0, 0, 0, 0)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
                     + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


out = HERE.parent / "ui" / "assets" / "terrain.png"
write_png_gray(out, img)
print(f"terrain.png {img.shape}, {out.stat().st_size/1024:.0f} KB, "
      f"m range {m.min():.2f}..{m.max():.2f}")
