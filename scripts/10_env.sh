#!/usr/bin/env bash
set -euo pipefail
source ./00_env.sh

echo "== Destroy: Glue crawlers + DB (B) =="
aws glue delete-crawler --profile "$PROF_B" --region "$REGION" --name "$CRAWLER_B" || true

# Delete tables in the DB (if it exists)
TABLES=$(aws glue get-tables --profile "$PROF_B" --region "$REGION" \
  --database-name "$GLUE_DB_B" --query 'TableList[].Name' --output text 2>/dev/null || true)

for t in $TABLES; do
  aws glue delete-table --profile "$PROF_B" --region "$REGION" \
    --database-name "$GLUE_DB_B" --name "$t" || true
done

aws glue delete-database --profile "$PROF_B" --region "$REGION" --name "$GLUE_DB_B" || true

echo "== Destroy: Clean Rooms configured tables (B) =="
# Delete configured tables if you have them (list + delete)
CT_IDS=$(aws cleanrooms list-configured-tables --profile "$PROF_B" --region "$REGION" \
  --query 'configuredTableSummaries[].id' --output text 2>/dev/null || true)

for id in $CT_IDS; do
  aws cleanrooms delete-configured-table --profile "$PROF_B" --region "$REGION" \
    --configured-table-identifier "$id" || true
done

echo "== Destroy: Clean Rooms collaborations/memberships =="
# Collaborations are owned by the creator account. If B created it:
COLLAB_IDS=$(aws cleanrooms list-collaborations --profile "$PROF_B" --region "$REGION" \
  --query 'collaborationSummaries[].id' --output text 2>/dev/null || true)

for cid in $COLLAB_IDS; do
  # must delete memberships first (in that account)
  MID=$(aws cleanrooms list-memberships --profile "$PROF_B" --region "$REGION" \
    --query "membershipSummaries[?collaborationId=='$cid'].id | [0]" --output text 2>/dev/null || true)
  if [[ "$MID" != "None" && -n "$MID" ]]; then
    aws cleanrooms delete-membership --profile "$PROF_B" --region "$REGION" --membership-identifier "$MID" || true
  fi
  aws cleanrooms delete-collaboration --profile "$PROF_B" --region "$REGION" --collaboration-identifier "$cid" || true
done

# Repeat for A if A created collab:
COLLAB_IDS_A=$(aws cleanrooms list-collaborations --profile "$PROF_A" --region "$REGION" \
  --query 'collaborationSummaries[].id' --output text 2>/dev/null || true)

for cid in $COLLAB_IDS_A; do
  MID=$(aws cleanrooms list-memberships --profile "$PROF_A" --region "$REGION" \
    --query "membershipSummaries[?collaborationId=='$cid'].id | [0]" --output text 2>/dev/null || true)
  if [[ "$MID" != "None" && -n "$MID" ]]; then
    aws cleanrooms delete-membership --profile "$PROF_A" --region "$REGION" --membership-identifier "$MID" || true
  fi
  aws cleanrooms delete-collaboration --profile "$PROF_A" --region "$REGION" --collaboration-identifier "$cid" || true
done

echo "== Optional: empty buckets =="
# aws s3 rm "s3://${RAW_BUCKET_B}" --recursive --profile "$PROF_B" || true
# aws s3 rm "s3://${RESULTS_BUCKET_B}" --recursive --profile "$PROF_B" || true

echo "Destroy done."
