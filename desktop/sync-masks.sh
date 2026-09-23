#!/bin/bash
# Copy the session's masks to S3. open_project.py saves by atomic rename, so
# every *_masks.tif.gz here is complete; .tmp and .staging files are mid-save.
set -euo pipefail
. /etc/annotate/session.env
exec aws s3 sync --only-show-errors \
  --exclude '*' --include '*_masks.tif.gz' --include '*_masks.tif' \
  "/session/$REGION/masks/" "s3://$BUCKET/regions/$REGION/masks/"
