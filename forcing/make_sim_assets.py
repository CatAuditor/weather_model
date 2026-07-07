#!/usr/bin/env python3
"""Build the web UI's live-simulator forcing assets from ERA5_2d files.

The simulator runs UTrack's 2-D scheme in the browser using:
  u_eff = viwve / tcw   (moisture-flux-weighted eastward wind, m/s)
  v_eff = viwvn / tcw
  rain  = tp*1000 / tcw (fraction of the moisture column rained out per hour)

For each input day it writes ui/assets/sim_forcing_MM.bin.gz containing:
  int8  u[24][181][360]   scale 0.5 m/s (clamped ±63 m/s)
  int8  v[24][181][360]
  uint8 r[24][181][360]   rain fraction/hour, scale 1/500
Grid: 1° (lat 90..-90, lon 0..359), 24 hourly steps.

Usage:  python3 make_sim_assets.py ERA5_2d15012025.nc [more files...]
The month in the output name is taken from the input filename (DDMMYYYY).
"""
import gzip
import re
import sys
from pathlib import Path

import netCDF4
import numpy as np

OUT_DIR = Path(__file__).resolve().parent.parent / "ui" / "assets"


def to_1deg(a):
    a = a[:, :720, :]  # 720 lat rows -> 180 one-degree blocks
    out = a.reshape(24, 180, 4, 360, 4).mean(axis=(2, 4))
    return np.concatenate([out, out[:, -1:, :]], axis=1)  # repeat south-pole row


def build(path):
    m = re.search(r"ERA5_2d\d{2}(\d{2})\d{4}\.nc$", str(path))
    if not m:
        sys.exit(f"cannot infer month from filename: {path}")
    month = m.group(1)
    ds = netCDF4.Dataset(path)
    tcw = np.maximum(np.asarray(ds.variables["tcw"][:], dtype=np.float64), 0.5)
    u = np.clip(to_1deg(np.asarray(ds.variables["viwve"][:], dtype=np.float64) / tcw), -63, 63)
    v = np.clip(to_1deg(np.asarray(ds.variables["viwvn"][:], dtype=np.float64) / tcw), -63, 63)
    r = to_1deg(np.clip(np.asarray(ds.variables["tp"][:], dtype=np.float64) * 1000.0 / tcw, 0, 0.5))
    blob = (np.round(u * 2).astype(np.int8).tobytes()
            + np.round(v * 2).astype(np.int8).tobytes()
            + np.round(r * 500).astype(np.uint8).tobytes())
    out = OUT_DIR / f"sim_forcing_{month}.bin.gz"
    out.write_bytes(gzip.compress(blob, 9))
    print(f"{out.name}: {out.stat().st_size/1e6:.2f} MB "
          f"(|u| mean {np.abs(u).mean():.1f} m/s, rain mean {r.mean()*100:.2f}%/h)")


for p in sys.argv[1:]:
    build(p)
