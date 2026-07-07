# UTrack Workbench — Technical Summary & Specifications

*This document mirrors the "Specs" tab of the deployed app
(https://main.d12gw6z761xtmp.amplifyapp.com). Update both together.*

## Summary

The system has three parts:

1. **UTrack model** — the published atmospheric moisture-tracking model
   (Tuinenburg & Staal, *Hydrol. Earth Syst. Sci.* 24, 2419–2435, 2020,
   doi:10.5194/hess-24-2419-2020), a C/OpenMP batch code that tags moisture
   evaporating from user-defined source cells and tracks it through ERA5
   reanalysis weather until it precipitates. Ported in this repo to current
   toolchains and the current Copernicus CDS data format; runs in Docker on
   AWS (EC2 or Batch) with S3 staging.
2. **Web workbench** — a static single-page app (AWS Amplify Hosting, no
   backend) for designing runs (release-mask editor exporting model-ready
   NetCDF-3), viewing model output (client-side NetCDF parsing; files never
   leave the browser), and interactive exploration.
3. **Live simulator** — a browser implementation of UTrack's 2-D scheme on
   preprocessed real ERA5 fields, for instant emitter/run/reset
   experimentation. Demonstrative, not a substitute for full 3-D runs.

## Full model (batch, AWS)

- **Grid:** global 0.25° (721 × 1440), 25 pressure levels (50–1000 hPa), hourly.
- **Forcing:** ERA5 via CDS API; 5 files/day (t, q, w, u+v on pressure levels;
  single-level file with tcw, viwve, viwvn, e, tp). Measured ~5.8 GB/day.
  A run needs `RELEASE_DAYS + 24` consecutive days (≥ 25 days ≈ 145 GB).
- **Physics:** parcels released proportional to ERA5 evaporation from masked
  cells; advected by 3-D winds (or 2-D moisture-flux winds, scheme-dependent);
  vertical mixing timescales 1–120 h by scheme (reference: 6 h Lagrangian
  = scheme 4; 3-D Eulerian reference = scheme 7); allocation to precipitation
  at rate P/PW per step. Moisture is a passive tracer (linear in amount).
- **Output:** NetCDF-3, global 0.25° fields `released`, `allocated`,
  `insystem` (mm per cell, time-integrated).
- **Resources:** ~3–4 GB RAM + parcel arrays; OpenMP-parallel; disk dominated
  by forcing.
- **Compatibility fixes made in this repo** (current CDS API): unpacked floats
  (default scale/offset), `viwve`/`viwvn` variable names, pressure levels
  delivered surface-first (detected and reversed to the model's ascending
  order), zip-wrapped single-level downloads (merged by `forcing/get_ERA5.py`).
- **Validation:** full run on real 2012-07-01 forcing — 4.41 mm released from
  the Utrecht cell, 67 % allocated downwind (max in Siberia), mass budget
  closed (released = allocated + airborne). Browser-written masks verified
  against `ncdump`, python-netCDF4, and the compiled model.

## Live simulator (browser)

**Scheme** (equations from UTrack's 2-D variant, `interpolation.c`):

- Advection: u_eff = viwve / tcw, v_eff = viwvn / tcw (moisture-flux-weighted
  column wind, m/s).
- Rainout: fraction per hour r = tp·1000 / tcw, capped at 50 %/h; parcel
  deposits vol · r · Δt/3600 each step.
- Dispersion: per-parcel Langevin (Ornstein–Uhlenbeck) velocity perturbation,
  u′ ← u′(1 − Δt/τ) + σ(x,y,t)·√(2Δt/τ)·ξ, with τ = 6 h (the model's
  reference mixing timescale) and σ = the ERA5 humidity-weighted standard
  deviation of wind across the column's 25 pressure levels (global mean
  ≈ 3.2 m/s, p95 ≈ 8 m/s). Stands in for the vertical-shear spreading the
  2-D column collapse removes. UI exposes 0.5×/1×/1.5× as sensitivity test.
- Time step Δt = 300 s; speeds 1/4/12 sim-hours per wall-second.
- Budget: emitted = airborne + rained out, in acre-feet
  (1 ac-ft = 1233.48 m³); closure is exact by construction and displayed live.

**Data** (`ui/assets/sim_forcing_MM.bin.gz`, layout v3, ~4.8 MB/month):

| Field | Grid | Encoding |
|---|---|---|
| u, v (moisture-flux wind) | 1°, hourly (24 × 181 × 360) | int8, 0.5 m/s, clamp ±63 |
| σu, σv (shear dispersion) | 1°, hourly | uint8, 0.1 m/s, clamp 25.5 |
| r (rainout fraction/h) | **0.5°**, hourly (24 × 361 × 720) | uint8, 1/500, cap 51 % |

Source: ERA5, the **15th of each month of 2025**, looped daily. Rainout and
the deposition map are kept at 0.5° so ERA5's real orographic precipitation
(windward enhancement, rain shadows) survives downsampling — mountains enter
through the data, not a parameterization. Basemap hillshade is ERA5
orography (`forcing/make_terrain.py`); visual only.

**Known limitations** (state these when presenting):

- One representative day per month, looped: multi-week runs re-experience
  that day's weather, not an evolving synoptic sequence.
- 2-D column transport: no explicit vertical structure; shear dispersion is
  statistical, not resolved.
- 0.5°/1° resolution: major ranges and shadows resolve; individual valleys
  do not. Quantitative work belongs to the full 3-D model at 0.25°.
- Emission rates are passive-tracer scalings; they do not feed back on the
  weather (valid for amounts small relative to atmospheric moisture).

## Web app / deployment

- **Hosting:** AWS Amplify (app `weather_model`, auto-deploy from GitHub
  `main`; `amplify.yml` serves `ui/` as static artifacts). No backend, no
  accounts; result files dropped into the viewer are parsed entirely
  client-side.
- **Stack:** vanilla JS + Canvas; own NetCDF-3 reader/writer
  (`ui/netcdf.js`); validated accessible palette, light/dark themes.
- **Model deployment:** Docker (Ubuntu 24.04 + libnetcdf), entrypoint stages
  forcing/masks from S3 and uploads results; see `README-DEPLOY.md`.
  Credentials: CDS token via `CDSAPI_URL`/`CDSAPI_KEY` env vars (Secrets
  Manager), AWS via IAM roles; nothing in the repo or image.

## Data pipeline

| Script | Purpose |
|---|---|
| `forcing/get_ERA5.py Y M D [NDAYS]` | full-model forcing (5 files/day; handles CDS zip-merge) |
| `forcing/make_sim_assets.py ERA5_2d*.nc` | simulator month assets (needs `ERA5_uv1deg*/q1deg*` companions, CDS `grid: [1.0,1.0]`) |
| `forcing/make_terrain.py` | basemap hillshade from `ERA5_orography.nc` |

## References

- Tuinenburg, O. A. & Staal, A. (2020), HESS 24, 2419–2435,
  doi:10.5194/hess-24-2419-2020 — model physics and scheme numbering.
- Upstream code: github.com/ObbeTuinenburg/UTrack-atmospheric-moisture.
- This repo: github.com/CatAuditor/weather_model.
- ERA5: Copernicus Climate Data Store (cds.climate.copernicus.eu).
