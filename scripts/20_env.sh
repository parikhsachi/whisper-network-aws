#!/usr/bin/env bash
set -euo pipefail
source ./00_env.sh

create_bucket () {
  local prof="$1"
  local bucket="$2"

  aws s3api create-bucket --profile "$prof" --region "$REGION" \
    --bucket "$bucket" --create-bucket-configuration LocationConstraint="$REGION" 2>/dev/null || true

  aws s3api put-public-access-block --profile "$prof" --region "$REGION" --bucket "$bucket" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

  aws s3api put-bucket-versioning --profile "$prof" --region "$REGION" --bucket "$bucket" \
    --versioning-configuration Status=Enabled

  aws s3api put-bucket-encryption --profile "$prof" --region "$REGION" --bucket "$bucket" \
    --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
}

echo "== Create buckets (B) =="
create_bucket "$PROF_B" "$RAW_BUCKET_B"
create_bucket "$PROF_B" "$RESULTS_BUCKET_B"

echo "== Create prefixes =="
aws s3api put-object --profile "$PROF_B" --region "$REGION" --bucket "$RAW_BUCKET_B" --key "${RAW_PREFIX}"
aws s3api put-object --profile "$PROF_B" --region "$REGION" --bucket "$RESULTS_BUCKET_B" --key "${RESULTS_PREFIX}"

echo "Storage done."
