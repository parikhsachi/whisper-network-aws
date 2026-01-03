#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/00_env.sh"

echo "== [50] Verify caller identities =="
echo "MAIN:"
aws sts get-caller-identity --profile "$PROF_MAIN"
echo "B:"
aws sts get-caller-identity --profile "$PROF_B"

echo
echo "== [50] Verify provider Glue table exists =="
aws glue get-table \
  --profile "$PROF_B" --region "$REGION" \
  --database-name "$GLUE_DB_B" --name "$GLUE_TABLE_B" \
  --query '{db:DatabaseName, table:Name}' --output table

echo
echo "== [50] Verify provider configured table exists =="
aws cleanrooms list-configured-tables \
  --profile "$PROF_B" --region "$REGION" \
  --query "configuredTableSummaries[?name=='${GLUE_TABLE_B}'].[name,id]" \
  --output table

CT_ID="$(aws cleanrooms list-configured-tables \
  --profile "$PROF_B" --region "$REGION" \
  --query "configuredTableSummaries[?name=='${GLUE_TABLE_B}'].id | [0]" \
  --output text)"

echo "ResolvedConfiguredTableId=$CT_ID"
if [[ -z "${CT_ID}" || "${CT_ID}" == "None" ]]; then
  echo "ERROR: Configured table not found. Run 40_create_cleanrooms.sh"
  exit 1
fi

echo
echo "== [50] Verify DIRECT_QUERY analysis rule exists =="
aws cleanrooms list-configured-table-analysis-rules \
  --profile "$PROF_B" --region "$REGION" \
  --configured-table-identifier "$CT_ID" \
  --query "analysisRuleSummaries[].type" --output table

echo
echo "== [50] Verify collaboration exists (consumer owns) =="
COLLAB_ID="$(aws cleanrooms list-collaborations \
  --profile "$PROF_MAIN" --region "$REGION" \
  --query "collaborationSummaries[?name=='spywhisper-collab'].id | [0]" \
  --output text)"
echo "CollaborationId=$COLLAB_ID"
if [[ -z "${COLLAB_ID}" || "${COLLAB_ID}" == "None" ]]; then
  echo "ERROR: Collaboration not found. Run 40_create_cleanrooms.sh"
  exit 1
fi

echo
echo "== [50] Verify provider membership exists for collaboration =="
MID_B="$(aws cleanrooms list-memberships \
  --profile "$PROF_B" --region "$REGION" \
  --query "membershipSummaries[?collaborationId=='${COLLAB_ID}'].id | [0]" \
  --output text)"
echo "MembershipIdProvider=$MID_B"
if [[ -z "${MID_B}" || "${MID_B}" == "None" ]]; then
  echo "ERROR: Provider membership not found. Run 40_create_cleanrooms.sh"
  exit 1
fi

echo
echo "== [50] Verify configured table association exists (provider) =="
aws cleanrooms list-configured-table-associations \
  --profile "$PROF_B" --region "$REGION" \
  --membership-identifier "$MID_B" \
  --query "configuredTableAssociationSummaries[?configuredTableId=='${CT_ID}'].[name,id,configuredTableId]" \
  --output table

echo
echo "== [50] Verify receiver role policy exists (consumer) =="
aws iam get-role-policy \
  --profile "$PROF_MAIN" \
  --role-name "$CLEANROOMS_RECEIVER_ROLE_MAIN" \
  --policy-name "CleanRoomsWriteResults" \
  --query 'PolicyDocument' --output json >/dev/null
echo "Receiver role inline policy present: CleanRoomsWriteResults"

echo
echo "== [50] Verify results prefix exists (consumer S3) =="
aws s3api head-object \
  --profile "$PROF_MAIN" --region "$REGION" \
  --bucket "$RESULTS_BUCKET_MAIN" --key "${RESULTS_PREFIX}" >/dev/null
echo "Results prefix object exists: s3://${RESULTS_BUCKET_MAIN}/${RESULTS_PREFIX}"

echo
echo "== [50] Done =="
