FROM ubuntu:24.04 AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc make libnetcdf-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY makefile *.c *.h ./
RUN make all

FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends \
        libnetcdf-dev libgomp1 ca-certificates curl unzip python3 python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscli.zip \
    && unzip -q /tmp/awscli.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscli.zip \
    && pip3 install --no-cache-dir --break-system-packages cdsapi netCDF4

WORKDIR /model
COPY --from=build /src/run_recycling .
COPY forcing/landmask.nc forcing/get_ERA5.py forcing/
COPY input/ input/
COPY list.txt entrypoint.sh ./
RUN chmod +x entrypoint.sh && mkdir -p output

ENTRYPOINT ["./entrypoint.sh"]
