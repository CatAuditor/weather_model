#!/usr/bin/env python3
"""Download one day (or a range) of ERA5 forcing for UTrack.

Produces the five files per day that run_recycling reads from ./forcing/:
    ERA5_2dDDMMYYYY.nc   tcw, viwve, viwvn, e, tp        (single levels)
    ERA5_qDDMMYYYY.nc    specific humidity, 25 levels
    ERA5_tDDMMYYYY.nc    temperature, 25 levels
    ERA5_wDDMMYYYY.nc    vertical velocity, 25 levels
    ERA5_uvDDMMYYYY.nc   u and v wind, 25 levels

Requires a CDS account and ~/.cdsapirc (https://cds.climate.copernicus.eu/how-to-api).

Usage:
    python3 get_ERA5.py YEAR MONTH DAY [NDAYS]

A model run of `./run_recycling Y M D R` needs R+24 consecutive days of
forcing starting at Y-M-D, so fetch with NDAYS = R+24.
"""
import datetime
import os
import sys
import tempfile
import zipfile

import cdsapi

PRESSURE_LEVELS = [
    "50", "100", "150", "200", "250", "300",
    "350", "400", "450", "500", "550", "600", "650",
    "700", "750", "775", "800", "825", "850", "875",
    "900", "925", "950", "975", "1000",
]
ALL_HOURS = [f"{h:02d}:00" for h in range(24)]

PRESSURE_LEVEL_FILES = {
    "w": ["vertical_velocity"],
    "uv": ["u_component_of_wind", "v_component_of_wind"],
    "q": ["specific_humidity"],
    "t": ["temperature"],
}
SINGLE_LEVEL_VARS = [
    "total_column_water",
    "vertical_integral_of_eastward_water_vapour_flux",
    "vertical_integral_of_northward_water_vapour_flux",
    "evaporation",
    "total_precipitation",
]


def merge_netcdf_zip(zip_path, out_path):
    """The CDS ships a zip when a request mixes instantaneous and accumulated
    variables (two NetCDF members). Merge them into the single file UTrack reads."""
    import netCDF4

    with tempfile.TemporaryDirectory() as td:
        with zipfile.ZipFile(zip_path) as z:
            members = [z.extract(n, td) for n in z.namelist() if n.endswith(".nc")]
        srcs = [netCDF4.Dataset(m) for m in members]
        out = netCDF4.Dataset(out_path, "w", format="NETCDF4")
        for d_name, dim in srcs[0].dimensions.items():
            out.createDimension(d_name, len(dim))
        for src in srcs:
            for v_name, var in src.variables.items():
                if v_name in out.variables:
                    continue
                fill = getattr(var, "_FillValue", None)
                v = out.createVariable(v_name, var.dtype, var.dimensions,
                                       zlib=var.ndim >= 3, complevel=1, fill_value=fill)
                v.setncatts({k: var.getncattr(k) for k in var.ncattrs() if k != "_FillValue"})
                v[:] = var[:]
            src.close()
        out.close()


def unzip_if_needed(path):
    if not zipfile.is_zipfile(path):
        return
    tmp = path + ".zip"
    os.replace(path, tmp)
    merge_netcdf_zip(tmp, path)
    os.remove(tmp)


def fetch_day(client, date):
    tag = f"{date.day:02d}{date.month:02d}{date.year}"
    base = {
        "product_type": "reanalysis",
        "year": str(date.year),
        "month": f"{date.month:02d}",
        "day": f"{date.day:02d}",
        "time": ALL_HOURS,
        "data_format": "netcdf",
        "download_format": "unarchived",
    }
    for short, variables in PRESSURE_LEVEL_FILES.items():
        client.retrieve(
            "reanalysis-era5-pressure-levels",
            {**base, "variable": variables, "pressure_level": PRESSURE_LEVELS},
            f"ERA5_{short}{tag}.nc",
        )
    client.retrieve(
        "reanalysis-era5-single-levels",
        {**base, "variable": SINGLE_LEVEL_VARS},
        f"ERA5_2d{tag}.nc",
    )
    unzip_if_needed(f"ERA5_2d{tag}.nc")


def main():
    if len(sys.argv) < 4:
        sys.exit(__doc__)
    year, month, day = (int(a) for a in sys.argv[1:4])
    ndays = int(sys.argv[4]) if len(sys.argv) > 4 else 1

    client = cdsapi.Client()
    start = datetime.date(year, month, day)
    for offset in range(ndays):
        date = start + datetime.timedelta(days=offset)
        print(f"Fetching ERA5 forcing for {date.isoformat()}")
        fetch_day(client, date)


if __name__ == "__main__":
    main()
