#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/00_env.sh"

# Disable AWS CLI pager (prevents "(END)" / less from breaking pipes)
export AWS_PAGER=""

echo "== [50] Verify caller identities =="
echo "REGION=$REGION"
echo "PROF_MAIN=$PROF_MAIN ACCT_MAIN=$ACCT_MAIN"
echo "PROF_B=$PROF_B ACCT_B=$ACCT_B"

echo
echo "== [50] Resolve COLLAB_ID (newest spywhisper-collab) =="

# If you already set COLLAB_ID_MAIN in 00_env.sh, respect it.
if [[ -n "${COLLAB_ID_MAIN:-}" ]]; then
  COLLAB_ID="$COLLAB_ID_MAIN"
else
  COLLAB_ID="$(
    aws cleanrooms list-collaborations \
      --profile "$PROF_MAIN" --region "$REGION" \
      --query "reverse(sort_by(collaborationList[?name=='spywhisper-collab'], &createTime))[0].id" \
      --output text
  )"
fi

echo "COLLAB_ID=$COLLAB_ID"
if [[ -z "$COLLAB_ID" || "$COLLAB_ID" == "None" ]]; then
  echo "ERROR: Could not resolve collaboration id for spywhisper-collab"
  exit 1
fi

echo
echo "== [50] Ensure membership exists in tape-main (query runner) =="
MEM_MAIN="$(
  aws cleanrooms list-memberships \
    --profile "$PROF_MAIN" --region "$REGION" \
    --query "membershipSummaries[?collaborationId=='${COLLAB_ID}'].id | [0]" \
    --output text 2>/dev/null || true
)"
if [[ -z "$MEM_MAIN" || "$MEM_MAIN" == "None" ]]; then
  MEM_MAIN="$(
    aws cleanrooms create-membership \
      --profile "$PROF_MAIN" --region "$REGION" \
      --collaboration-identifier "$COLLAB_ID" \
      --query-log-status "ENABLED" \
      --query "membership.id" --output text
  )"
fi
echo "MEM_MAIN=$MEM_MAIN"

echo
echo "== [50] Ensure membership exists in tape-b (provider) =="
MEM_B="$(
  aws cleanrooms list-memberships \
    --profile "$PROF_B" --region "$REGION" \
    --query "membershipSummaries[?collaborationId=='${COLLAB_ID}'].id | [0]" \
    --output text 2>/dev/null || true
)"
if [[ -z "$MEM_B" || "$MEM_B" == "None" ]]; then
  # Provider membership needs a default result config
  ROLE_ARN_B="$(aws iam get-role \
    --profile "$PROF_B" \
    --role-name "cleanrooms-results-writer-b" \
    --query Role.Arn --output text)"

  MEM_B="$(
    aws cleanrooms create-membership \
      --profile "$PROF_B" --region "$REGION" \
      --collaboration-identifier "$COLLAB_ID" \
      --query-log-status "ENABLED" \
      --default-result-configuration "outputConfiguration={s3={resultFormat=CSV,bucket=${RESULTS_BUCKET_B},keyPrefix=${RESULTS_PREFIX_B}}},roleArn=${ROLE_ARN_B}" \
      --query "membership.id" --output text
  )"
fi
echo "MEM_B=$MEM_B"

echo
echo "== [50] Get provider configured table association name (from tape-b membership) =="
PROVIDER_ASSOC_NAME="$(
  aws cleanrooms list-configured-table-associations \
    --profile "$PROF_B" --region "$REGION" \
    --membership-identifier "$MEM_B" \
    --query "configuredTableAssociationSummaries[?name=='${GLUE_TABLE_B}-assoc'].name | [0]" \
    --output text 2>/dev/null || true
)"
echo "PROVIDER_ASSOC_NAME=$PROVIDER_ASSOC_NAME"
if [[ -z "$PROVIDER_ASSOC_NAME" || "$PROVIDER_ASSOC_NAME" == "None" ]]; then
  echo "ERROR: Provider association not found. Re-run script 40 on tape-b side."
  exit 1
fi

echo
echo "== [50] Ensure tape-main results bucket policy allows cleanrooms query receiver role to write =="
RECEIVER_ROLE_ARN="$(aws iam get-role \
  --profile "$PROF_MAIN" \
  --role-name "$CLEANROOMS_RECEIVER_ROLE_MAIN" \
  --query Role.Arn --output text)"
echo "RECEIVER_ROLE_ARN=$RECEIVER_ROLE_ARN"

# Create bucket if missing (idempotent)
aws s3api create-bucket \
  --profile "$PROF_MAIN" --region "$REGION" \
  --bucket "$RESULTS_BUCKET_MAIN" \
  --create-bucket-configuration LocationConstraint="$REGION" \
  2>/dev/null || true

aws s3api put-public-access-block \
  --profile "$PROF_MAIN" --region "$REGION" --bucket "$RESULTS_BUCKET_MAIN" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true >/dev/null

aws s3api put-bucket-encryption \
  --profile "$PROF_MAIN" --region "$REGION" --bucket "$RESULTS_BUCKET_MAIN" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' >/dev/null

aws s3api put-object \
  --profile "$PROF_MAIN" --region "$REGION" \
  --bucket "$RESULTS_BUCKET_MAIN" --key "${RESULTS_PREFIX}" >/dev/null || true

cat > /tmp/results_bucket_policy_main.json <<EOF
{
  "Version":"2012-10-17",
  "Statement":[
    {
      "Sid":"AllowReceiverListBucket",
      "Effect":"Allow",
      "Principal":{"AWS":"${RECEIVER_ROLE_ARN}"},
      "Action":["s3:ListBucket","s3:GetBucketLocation"],
      "Resource":"arn:aws:s3:::${RESULTS_BUCKET_MAIN}"
    },
    {
      "Sid":"AllowReceiverWritePrefix",
      "Effect":"Allow",
      "Principal":{"AWS":"${RECEIVER_ROLE_ARN}"},
      "Action":["s3:PutObject","s3:AbortMultipartUpload","s3:PutObjectTagging"],
      "Resource":"arn:aws:s3:::${RESULTS_BUCKET_MAIN}/${RESULTS_PREFIX}*"
    }
  ]
}
EOF

aws s3api put-bucket-policy \
  --profile "$PROF_MAIN" --region "$REGION" \
  --bucket "$RESULTS_BUCKET_MAIN" \
  --policy file:///tmp/results_bucket_policy_main.json >/dev/null

echo "OK: results bucket policy applied"

echo
echo "== [50] Run a small protected query from tape-main =="

QUERY="SELECT COUNT(*) AS n FROM \"${PROVIDER_ASSOC_NAME}\";"
echo "QUERY=$QUERY"

cat > /tmp/sql_params.json <<EOF
{
  "queryString": $(python3 - <<PY
import json
print(json.dumps("""$QUERY"""))
PY
)
}
EOF

PROTECTED_QUERY_ID="$(
  aws cleanrooms start-protected-query \
    --profile "$PROF_MAIN" --region "$REGION" \
    --type SQL \
    --membership-identifier "$MEM_MAIN" \
    --sql-parameters file:///tmp/sql_params.json \
    --query "protectedQuery.id" --output text
)"

echo "PROTECTED_QUERY_ID=$PROTECTED_QUERY_ID"

echo
echo "== [50] Done. Check status =="
aws cleanrooms get-protected-query \
  --profile "$PROF_MAIN" --region "$REGION" \
  --membership-identifier "$MEM_MAIN" \
  --protected-query-identifier "$PROTECTED_QUERY_ID" \
  --query "{status:protectedQuery.status,result:protectedQuery.result}" \
  --output json
