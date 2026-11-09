#!/bin/sh
# Idempotently provision private Relay buckets on an S3-compatible endpoint.
# - Buckets stay private (no public ACLs, no website hosting, no listing for anonymous users).
# - Versioning is enabled so a validated object version can be pinned.
# - CORS allows only the configured web origins to PUT parts / GET previews via presigned URLs,
#   and exposes ETag so the browser can report multipart part ETags.
set -eu

: "${S3_ENDPOINT:?S3_ENDPOINT is required}"
: "${S3_BUCKETS:?S3_BUCKETS is required}"
: "${S3_CORS_ORIGINS:?S3_CORS_ORIGINS is required}"

origins_json=""
for origin in $S3_CORS_ORIGINS; do
  if [ -n "$origins_json" ]; then origins_json="$origins_json,"; fi
  origins_json="$origins_json\"$origin\""
done

cors_file=$(mktemp)
cat > "$cors_file" <<EOF
{
  "CORSRules": [
    {
      "AllowedOrigins": [$origins_json],
      "AllowedMethods": ["PUT", "GET", "HEAD"],
      "AllowedHeaders": ["content-type", "content-length", "if-none-match", "x-amz-checksum-sha256", "x-amz-sdk-checksum-algorithm"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 600
    }
  ]
}
EOF

for bucket in $S3_BUCKETS; do
  if aws --endpoint-url "$S3_ENDPOINT" s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
    echo "bucket $bucket exists"
  else
    aws --endpoint-url "$S3_ENDPOINT" s3api create-bucket --bucket "$bucket" >/dev/null
    echo "bucket $bucket created"
  fi
  aws --endpoint-url "$S3_ENDPOINT" s3api put-bucket-versioning --bucket "$bucket" \
    --versioning-configuration Status=Enabled
  aws --endpoint-url "$S3_ENDPOINT" s3api put-bucket-cors --bucket "$bucket" \
    --cors-configuration "file://$cors_file"
  echo "bucket $bucket: versioning enabled, CORS applied for: $S3_CORS_ORIGINS"
done

rm -f "$cors_file"
