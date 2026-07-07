#!/usr/bin/env bash
# Container entrypoint for UTrack runs on AWS.
#
# Required env vars:
#   START_YEAR, START_MONTH, START_DAY  simulation start date
#   RELEASE_DAYS                        days of moisture release (run length is RELEASE_DAYS+24)
# Optional env vars:
#   FORCING_S3   s3://bucket/prefix holding ERA5_* forcing files (synced into ./forcing)
#   LIST_S3      s3://bucket/key of a list.txt to use instead of the baked-in one
#   INPUT_S3     s3://bucket/prefix of release-mask .nc files (synced into ./input)
#   OUTPUT_S3    s3://bucket/prefix to upload ./output results to after the run
set -euo pipefail

: "${START_YEAR:?set START_YEAR}" "${START_MONTH:?set START_MONTH}"
: "${START_DAY:?set START_DAY}" "${RELEASE_DAYS:?set RELEASE_DAYS}"

if [[ -n "${LIST_S3:-}" ]]; then
    aws s3 cp "$LIST_S3" list.txt
fi
if [[ -n "${INPUT_S3:-}" ]]; then
    aws s3 sync "$INPUT_S3" input/
fi
if [[ -n "${FORCING_S3:-}" ]]; then
    echo "Syncing forcing data from $FORCING_S3 ..."
    aws s3 sync "$FORCING_S3" forcing/
fi

./run_recycling "$START_YEAR" "$START_MONTH" "$START_DAY" "$RELEASE_DAYS"

if [[ -n "${OUTPUT_S3:-}" ]]; then
    echo "Uploading results to $OUTPUT_S3 ..."
    aws s3 sync output/ "$OUTPUT_S3"
fi
