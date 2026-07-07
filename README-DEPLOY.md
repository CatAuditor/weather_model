# Running and deploying UTrack

UTrack is a headless batch model: a single C binary (`run_recycling`) that reads
ERA5 forcing NetCDF files from `./forcing/`, release masks from `./input/`, a job
list from `./list.txt`, and writes result NetCDF files to `./output/`. There is no
UI, server, or API — one run is one process.

## Local build

macOS (Homebrew) and Linux are both handled by the makefile:

```sh
# macOS one-time setup
brew install netcdf libomp
# Linux (Debian/Ubuntu) one-time setup
apt-get install gcc make libnetcdf-dev

make all
```

## Running

```sh
./run_recycling YEAR MONTH DAY RELEASE_DAYS
```

The run simulates `RELEASE_DAYS + 24` days, so it needs that many consecutive
days of forcing files present in `./forcing/`. Jobs are defined in `list.txt`,
one per line:

```
SIMULATION_TYPE INTERPOLATION_TYPE PARCELS_PER_MM  INPUT_MASK  OUTPUT_FILE
7 1 1 ./input/utrecht0.nc ./output/out_utrecht_7.nc
```

Release masks (`./input/*.nc`) are 721x1440 grids with a `release` variable set
to 1 in source cells. Simulation types are described in Tuinenburg & Staal
(HESS 2020); type 7 is the Eulerian reference configuration.

## Forcing data

`forcing/get_ERA5.py` downloads everything a run needs from the Copernicus
Climate Data Store:

```sh
cd forcing
python3 get_ERA5.py 2012 7 1 29    # start date + number of days (RELEASE_DAYS+24)
```

Requirements:

- A CDS account with the ERA5 licence accepted, and credentials either in
  `~/.cdsapirc` or via the `CDSAPI_URL` / `CDSAPI_KEY` environment variables.
  **Never commit the token** — `.gitignore` blocks `.cdsapirc` and `.env`.
- Disk: roughly 7–13 GB per simulated day (five global files, four of them
  3-D on 25 pressure levels). A minimal 25-day run is ~200–300 GB, so plan
  storage accordingly and reuse downloaded periods across runs.

The C code accepts both legacy CDS files (short-packed, `p71.162`/`p72.162`
flux names) and current CDS API output (unpacked floats, `viwve`/`viwvn`).

## Docker

```sh
docker build -t utrack .
docker run --rm \
  -e START_YEAR=2012 -e START_MONTH=7 -e START_DAY=1 -e RELEASE_DAYS=5 \
  -v /data/forcing:/model/forcing \
  -v /data/output:/model/output \
  utrack
```

The entrypoint can instead stage data through S3 (see below), which is how the
AWS deployment works.

## AWS deployment

Recommended shape — S3 for data, ECR for the image, and either a single EC2
instance or AWS Batch for compute:

1. **S3 buckets/prefixes**
   - `s3://<bucket>/forcing/<period>/` — ERA5 files for a simulation period,
     downloaded once (from an EC2 box with CDS credentials) and reused.
   - `s3://<bucket>/output/<run-id>/` — results.
2. **Build and push the image**
   ```sh
   aws ecr create-repository --repository-name utrack
   aws ecr get-login-password | docker login --username AWS \
       --password-stdin <acct>.dkr.ecr.<region>.amazonaws.com
   docker build -t <acct>.dkr.ecr.<region>.amazonaws.com/utrack:latest .
   docker push <acct>.dkr.ecr.<region>.amazonaws.com/utrack:latest
   ```
3. **Run** (EC2 with an instance role that can read/write the buckets, or an
   AWS Batch job definition with the same env vars):
   ```sh
   docker run --rm \
     -e START_YEAR=2012 -e START_MONTH=7 -e START_DAY=1 -e RELEASE_DAYS=5 \
     -e FORCING_S3=s3://<bucket>/forcing/2012-07 \
     -e OUTPUT_S3=s3://<bucket>/output/run-001 \
     -e LIST_S3=s3://<bucket>/jobs/list.txt \
     <acct>.dkr.ecr.<region>.amazonaws.com/utrack:latest
   ```

### Entrypoint environment variables

| Variable | Required | Purpose |
|---|---|---|
| `START_YEAR/MONTH/DAY` | yes | simulation start date |
| `RELEASE_DAYS` | yes | days of moisture release (run = this + 24 days) |
| `FORCING_S3` | no | S3 prefix synced into `./forcing` before the run |
| `INPUT_S3` | no | S3 prefix synced into `./input` |
| `LIST_S3` | no | S3 key copied to `./list.txt` |
| `OUTPUT_S3` | no | S3 prefix `./output` is synced to after the run |

### Sizing

- **Memory:** ~3–4 GB (two hourly snapshots of five 3-D fields, ~1 GB, plus
  particle arrays that scale with mask size × release days × parcels).
- **CPU:** the Lagrangian particle loop is OpenMP-parallel; 8–16 vCPUs is a
  good starting point (e.g. `c7i.4xlarge`). Eulerian runs are single-threaded
  per job but multiple `list.txt` lines run within one process.
- **Disk:** dominated by forcing (see above). Use a gp3 EBS volume sized to
  the simulation period, or sync only the needed period from S3.

### Credentials hygiene

- CDS token: store in AWS Secrets Manager / SSM Parameter Store and inject as
  `CDSAPI_URL` + `CDSAPI_KEY` env vars when downloading forcing. It is not
  needed for model runs themselves.
- AWS access: use instance/task IAM roles, not access keys in the image.
