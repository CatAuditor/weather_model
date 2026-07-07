#!/usr/bin/env python3
"""Build the web UI's live-simulator forcing assets from ERA5 files.

The simulator runs UTrack's 2-D scheme in the browser using:
  u_eff = viwve / tcw   (moisture-flux-weighted eastward wind, m/s)
  v_eff = viwvn / tcw
  rain  = tp*1000 / tcw (fraction of the moisture column rained out per hour)
plus, when 1°-regridded 3-D u/v/q files are present, the dispersion fields
  sigma_u, sigma_v = humidity-weighted std-dev of the wind across the
  column's 25 pressure levels — the vertical-shear spread that drives
  horizontal dispersion in the full 3-D model.

For each input day it writes ui/assets/sim_forcing_MM.bin.gz (layout v3),
24 hourly steps; winds/dispersion on the 1° grid, rainout on 0.5° so that
orographic precipitation and rain shadows stay resolved:
  int8  u[24][181][360]    scale 0.5 m/s (clamped ±63 m/s)
  int8  v[24][181][360]
  uint8 su[24][181][360]   sigma_u, scale 0.1 m/s
  uint8 sv[24][181][360]   sigma_v, scale 0.1 m/s
  uint8 r[24][361][720]    rain fraction/hour, scale 1/500 (0.5° grid)

Usage:  python3 make_sim_assets.py ERA5_2d15012025.nc [more 2d files...]
Companion files ERA5_uv1deg<TAG>.nc / ERA5_q1deg<TAG>.nc are picked up
automatically when they sit next to the 2d file.
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


def to_halfdeg(a):
    a = a[:, :720, :]
    out = a.reshape(24, 360, 2, 720, 2).mean(axis=(2, 4))
    return np.concatenate([out, out[:, -1:, :]], axis=1)  # (24,361,720)


def shear_sigma(uv_path, q_path):
    """Humidity-weighted std of u and v across pressure levels, per hour/cell."""
    dsq = netCDF4.Dataset(q_path)
    dsu = netCDF4.Dataset(uv_path)
    q = np.maximum(np.asarray(dsq.variables["q"][:], dtype=np.float64), 1e-9)  # (24,25,lat,lon)
    w = q / q.sum(axis=1, keepdims=True)
    out = []
    for name in ("u", "v"):
        x = np.asarray(dsu.variables[name][:], dtype=np.float64)
        mean = (w * x).sum(axis=1, keepdims=True)
        out.append(np.sqrt(np.clip((w * (x - mean) ** 2).sum(axis=1), 0, None)))
    lat = np.asarray(dsq.variables["latitude"][:])
    if lat[0] < lat[-1]:  # ensure row 0 = 90N
        out = [np.ascontiguousarray(a[:, ::-1, :]) for a in out]
    return out  # [su, sv] each (24,181,360)


def build(path):
    path = Path(path)
    m = re.search(r"ERA5_2d(\d{2})(\d{2})(\d{4})\.nc$", path.name)
    if not m:
        sys.exit(f"cannot parse date from filename: {path}")
    tag, month = m.group(1) + m.group(2) + m.group(3), m.group(2)
    ds = netCDF4.Dataset(path)
    tcw = np.maximum(np.asarray(ds.variables["tcw"][:], dtype=np.float64), 0.5)
    u = np.clip(to_1deg(np.asarray(ds.variables["viwve"][:], dtype=np.float64) / tcw), -63, 63)
    v = np.clip(to_1deg(np.asarray(ds.variables["viwvn"][:], dtype=np.float64) / tcw), -63, 63)
    r = to_halfdeg(np.clip(np.asarray(ds.variables["tp"][:], dtype=np.float64) * 1000.0 / tcw, 0, 0.5))

    uv_path = path.parent / f"ERA5_uv1deg{tag}.nc"
    q_path = path.parent / f"ERA5_q1deg{tag}.nc"
    if not (uv_path.exists() and q_path.exists()):
        sys.exit(f"missing 3-D companion files for {tag} (needed for dispersion fields)")
    su, sv = shear_sigma(uv_path, q_path)
    note = f"sigma_u mean {su.mean():.1f} m/s, p95 {np.percentile(su, 95):.1f}"
    blob = (np.round(u * 2).astype(np.int8).tobytes()
            + np.round(v * 2).astype(np.int8).tobytes()
            + np.round(np.clip(su, 0, 25.5) * 10).astype(np.uint8).tobytes()
            + np.round(np.clip(sv, 0, 25.5) * 10).astype(np.uint8).tobytes()
            + np.round(r * 500).astype(np.uint8).tobytes())
    out = OUT_DIR / f"sim_forcing_{month}.bin.gz"
    out.write_bytes(gzip.compress(blob, 9))
    print(f"{out.name}: {out.stat().st_size/1e6:.2f} MB "
          f"(|u| mean {np.abs(u).mean():.1f} m/s, rain mean {r.mean()*100:.2f}%/h; {note})")


for p in sys.argv[1:]:
    build(p)
