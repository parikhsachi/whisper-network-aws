#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/00_env.sh"

: "${COLLAB_ID_MAIN:?ERROR: Set COLLAB_ID_MAIN in scripts/00_env.sh (quota hit; we must reuse an existing collaboration id)}"

echo "== [40] Ensure Glue table exists (provider: tape-b) =="
aws glue get-table \
  --profile "$PROF_B" --region "$REGION" \
  --database-name "$GLUE_DB_B" --name "$GLUE_TABLE_B" \
  --query 'Table.Name' --output text >/dev/null

echo "== [40] Derive allowed columns (JSON) from Glue schema (provider) =="
COLS_JSON="$(aws glue get-table \
  --profile "$PROF_B" --region "$REGION" \
  --database-name "$GLUE_DB_B" --name "$GLUE_TABLE_B" \
  --query 'Table.StorageDescriptor.Columns[].Name' \
  --output json)"

if [[ "${COLS_JSON:0:1}" != "[" ]]; then
  echo "ERROR: Failed to derive allowed columns JSON. Output:"
  echo "$COLS_JSON"
  exit 1
fi
echo "AllowedColumnsJSON=$COLS_JSON"

echo "== [40] Ensure configured table exists (provider / tape-b) =="
CT_ID="$(aws cleanrooms list-configured-tables \
  --profile "$PROF_B" --region "$REGION" \
  --query "configuredTableSummaries[?name=='${GLUE_TABLE_B}'].id | [0]" \
  --output text 2>/dev/null || true)"

if [[ -z "${CT_ID}" || "${CT_ID}" == "None" ]]; then
  CT_ID="$(aws cleanrooms create-configured-table \
    --profile "$PROF_B" --region "$REGION" \
    --name "${GLUE_TABLE_B}" \
    --table-reference "{\"glue\":{\"tableName\":\"${GLUE_TABLE_B}\",\"databaseName\":\"${GLUE_DB_B}\"}}" \
    --analysis-method "DIRECT_QUERY" \
    --allowed-columns "${COLS_JSON}" \
    --query 'configuredTable.id' --output text)"
fi
echo "ConfiguredTableId=$CT_ID"

echo "== [40] NOTE: Skipping DIRECT_QUERY analysis rule creation =="
echo "     Your local awscli model rejects DIRECT_QUERY analysisRulePolicy (expects list/aggregation/custom)."
echo "     Proceeding with configured table + allowed columns only."

COLLAB_ID="$COLLAB_ID_MAIN"
echo "== [40] Using existing collaboration (consumer: tape-main) =="
echo "CollaborationId=$COLLAB_ID"

echo "== [40] Ensure tape-b results bucket exists (receiver bucket) =="
aws s3api create-bucket \
  --profile "$PROF_B" --region "$REGION" \
  --bucket "$RESULTS_BUCKET_B" \
  --create-bucket-configuration LocationConstraint="$REGION" \
  2>/dev/null || true

aws s3api put-public-access-block \
  --profile "$PROF_B" --region "$REGION" --bucket "$RESULTS_BUCKET_B" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

aws s3api put-bucket-encryption \
  --profile "$PROF_B" --region "$REGION" --bucket "$RESULTS_BUCKET_B" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

aws s3api put-object \
  --profile "$PROF_B" --region "$REGION" \
  --bucket "$RESULTS_BUCKET_B" --key "${RESULTS_PREFIX_B}" >/dev/null || true

echo "== [40] Ensure results-writer role exists (tape-b) =="
RESULTS_WRITER_ROLE_B="cleanrooms-results-writer-b"

cat > /tmp/cleanrooms_results_writer_trust.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "cleanrooms.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

aws iam create-role \
  --profile "$PROF_B" \
  --role-name "$RESULTS_WRITER_ROLE_B" \
  --assume-role-policy-document file:///tmp/cleanrooms_results_writer_trust.json \
  2>/dev/null || true

ROLE_ARN_B="$(aws iam get-role \
  --profile "$PROF_B" \
  --role-name "$RESULTS_WRITER_ROLE_B" \
  --query 'Role.Arn' --output text)"
echo "ProviderResultsWriterRoleArn=$ROLE_ARN_B"

cat > /tmp/cleanrooms_results_writer_policy_b.json <<EOF
{
  "Version":"2012-10-17",
  "Statement":[
    {
      "Sid":"ListResultsPrefix",
      "Effect":"Allow",
      "Action":["s3:ListBucket","s3:GetBucketLocation"],
      "Resource":["arn:aws:s3:::${RESULTS_BUCKET_B}"],
      "Condition":{"StringLike":{"s3:prefix":["${RESULTS_PREFIX_B}*"]}}
    },
    {
      "Sid":"WriteResultsObjects",
      "Effect":"Allow",
      "Action":["s3:PutObject","s3:AbortMultipartUpload","s3:PutObjectTagging"],
      "Resource":["arn:aws:s3:::${RESULTS_BUCKET_B}/${RESULTS_PREFIX_B}*"]
    }
  ]
}
EOF

aws iam put-role-policy \
  --profile "$PROF_B" \
  --role-name "$RESULTS_WRITER_ROLE_B" \
  --policy-name "CleanRoomsWriteResultsLocal" \
  --policy-document file:///tmp/cleanrooms_results_writer_policy_b.json >/dev/null

cat > /tmp/results_bucket_policy_b.json <<EOF
{
  "Version":"2012-10-17",
  "Statement":[
    {
      "Sid":"AllowRoleListPrefix",
      "Effect":"Allow",
      "Principal":{"AWS":"${ROLE_ARN_B}"},
      "Action":["s3:ListBucket"],
      "Resource":"arn:aws:s3:::${RESULTS_BUCKET_B}",
      "Condition":{"StringLike":{"s3:prefix":["${RESULTS_PREFIX_B}*"]}}
    },
    {
      "Sid":"AllowRoleGetBucketLocation",
      "Effect":"Allow",
      "Principal":{"AWS":"${ROLE_ARN_B}"},
      "Action":["s3:GetBucketLocation"],
      "Resource":"arn:aws:s3:::${RESULTS_BUCKET_B}"
    },
    {
      "Sid":"AllowRoleWriteObjects",
      "Effect":"Allow",
      "Principal":{"AWS":"${ROLE_ARN_B}"},
      "Action":["s3:PutObject","s3:AbortMultipartUpload","s3:PutObjectTagging"],
      "Resource":"arn:aws:s3:::${RESULTS_BUCKET_B}/${RESULTS_PREFIX_B}*"
    },
    {
      "Sid":"AllowCleanRoomsServiceWriteObjects",
      "Effect":"Allow",
      "Principal":{"Service":"cleanrooms.amazonaws.com"},
      "Action":["s3:PutObject","s3:AbortMultipartUpload","s3:PutObjectTagging"],
      "Resource":"arn:aws:s3:::${RESULTS_BUCKET_B}/${RESULTS_PREFIX_B}*"
    }
  ]
}
EOF

aws s3api put-bucket-policy \
  --profile "$PROF_B" --region "$REGION" \
  --bucket "$RESULTS_BUCKET_B" \
  --policy file:///tmp/results_bucket_policy_b.json >/dev/null

echo "== [40] Ensure membership exists (provider / tape-b) =="
MID_B="$(aws cleanrooms list-memberships \
  --profile "$PROF_B" --region "$REGION" \
  --query "membershipSummaries[?collaborationId=='${COLLAB_ID}'].id | [0]" \
  --output text 2>/dev/null || true)"

if [[ -z "${MID_B}" || "${MID_B}" == "None" ]]; then
  MID_B="$(aws cleanrooms create-membership \
    --profile "$PROF_B" --region "$REGION" \
    --collaboration-identifier "$COLLAB_ID" \
    --query-log-status "ENABLED" \
    --default-result-configuration "outputConfiguration={s3={resultFormat=CSV,bucket=${RESULTS_BUCKET_B},keyPrefix=${RESULTS_PREFIX_B}}},roleArn=${ROLE_ARN_B}" \
    --query 'membership.id' --output text)"
fi
echo "MembershipIdProvider=$MID_B"

echo "== [40] Ensure configured table association exists (provider / tape-b) =="
ASSOC_ID="$(aws cleanrooms list-configured-table-associations \
  --profile "$PROF_B" --region "$REGION" \
  --membership-identifier "$MID_B" \
  --query "configuredTableAssociationSummaries[?configuredTableId=='${CT_ID}'].id | [0]" \
  --output text 2>/dev/null || true)"

if [[ -z "${ASSOC_ID}" || "${ASSOC_ID}" == "None" ]]; then
  PROVIDER_DATA_ROLE_ARN="$(aws iam get-role \
    --profile "$PROF_B" \
    --role-name "$GLUE_CRAWLER_ROLE_B" \
    --query 'Role.Arn' --output text)"
  echo "ProviderDataRoleArn=$PROVIDER_DATA_ROLE_ARN"

  ASSOC_ID="$(aws cleanrooms create-configured-table-association \
    --profile "$PROF_B" --region "$REGION" \
    --membership-identifier "$MID_B" \
    --configured-table-identifier "$CT_ID" \
    --name "${GLUE_TABLE_B}-assoc" \
    --description "Association for ${GLUE_TABLE_B}" \
    --role-arn "$DATA_ACCESS_ROLE_ARN_B" \
    --query 'configuredTableAssociation.id' --output text)"
fi

echo "ConfiguredTableAssociationId=$ASSOC_ID"
echo "== [40] Done =="
