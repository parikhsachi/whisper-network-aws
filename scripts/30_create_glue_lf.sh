#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/00_env.sh"

echo "== [30] Create Glue DB (provider / tape-b) =="
aws glue create-database \
  --profile "$PROF_B" --region "$REGION" \
  --database-input "{\"Name\":\"$GLUE_DB_B\"}" \
  2>/dev/null || true

echo "== [30] Resolve crawler role ARN =="
CRAWLER_ROLE_ARN="$(aws iam get-role \
  --profile "$PROF_B" \
  --role-name "$GLUE_CRAWLER_ROLE_B" \
  --query 'Role.Arn' --output text)"
echo "CrawlerRoleArn=$CRAWLER_ROLE_ARN"

echo "== [30] Register raw bucket as Lake Formation data lake location =="
# If already registered, this returns an error; we ignore it.
aws lakeformation register-resource \
  --profile "$PROF_B" --region "$REGION" \
  --resource-arn "arn:aws:s3:::${RAW_BUCKET_B}" \
  2>/dev/null || true

echo "== [30] Grant DATA_LOCATION_ACCESS on raw bucket to crawler role =="
aws lakeformation grant-permissions \
  --profile "$PROF_B" --region "$REGION" \
  --principal "DataLakePrincipalIdentifier=${CRAWLER_ROLE_ARN}" \
  --resource "{\"DataLocation\":{\"ResourceArn\":\"arn:aws:s3:::${RAW_BUCKET_B}\"}}" \
  --permissions "DATA_LOCATION_ACCESS" \
  2>/dev/null || true

echo "== [30] Grant LF permissions on DB to crawler role (create/update tables) =="
aws lakeformation grant-permissions \
  --profile "$PROF_B" --region "$REGION" \
  --principal "DataLakePrincipalIdentifier=${CRAWLER_ROLE_ARN}" \
  --resource "{\"Database\":{\"Name\":\"$GLUE_DB_B\"}}" \
  --permissions "CREATE_TABLE" "ALTER" "DESCRIBE" \
  2>/dev/null || true

echo "== [30] Create or update crawler =="
# If crawler exists, update its targets/db/role; else create it.
if aws glue get-crawler --profile "$PROF_B" --region "$REGION" --name "$CRAWLER_B" >/dev/null 2>&1; then
  aws glue update-crawler \
    --profile "$PROF_B" --region "$REGION" \
    --name "$CRAWLER_B" \
    --role "$GLUE_CRAWLER_ROLE_B" \
    --database-name "$GLUE_DB_B" \
    --targets "{\"S3Targets\":[{\"Path\":\"s3://${RAW_BUCKET_B}/${RAW_PREFIX}\"}]}"
else
  aws glue create-crawler \
    --profile "$PROF_B" --region "$REGION" \
    --name "$CRAWLER_B" \
    --role "$GLUE_CRAWLER_ROLE_B" \
    --database-name "$GLUE_DB_B" \
    --targets "{\"S3Targets\":[{\"Path\":\"s3://${RAW_BUCKET_B}/${RAW_PREFIX}\"}]}"
fi

echo "== [30] Start crawler =="
aws glue start-crawler --profile "$PROF_B" --region "$REGION" --name "$CRAWLER_B" 2>/dev/null || true

echo "== [30] Wait for crawler to finish (READY) =="
while true; do
  STATE="$(aws glue get-crawler \
    --profile "$PROF_B" --region "$REGION" \
    --name "$CRAWLER_B" \
    --query 'Crawler.State' --output text)"
  echo "CrawlerState=$STATE"
  [[ "$STATE" == "READY" ]] && break
  sleep 15
done

echo "== [30] Verify Glue table exists (provider) =="
aws glue get-tables \
  --profile "$PROF_B" --region "$REGION" \
  --database-name "$GLUE_DB_B" \
  --query 'TableList[].Name' --output table

echo "== [30] Done =="
