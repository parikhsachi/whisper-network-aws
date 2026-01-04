#!/usr/bin/env bash
set -euo pipefail
export AWS_PAGER=""
# ========= GLOBAL =========
export REGION="us-west-2"

# ========= EXISTING AWS PROFILES =========
# These MUST already exist in ~/.aws/config
export PROF_MAIN="tape-main"   # query / consumer / orchestration
export PROF_B="tape-b"         # data provider

# ========= ACCOUNT IDS (read-only, for policies) =========
export ACCT_MAIN=$(aws sts get-caller-identity --profile "$PROF_MAIN" --query Account --output text)
export ACCT_B=$(aws sts get-caller-identity --profile "$PROF_B" --query Account --output text)
export COLLAB_ID_MAIN="bce39e41-5d44-4ddf-a5ea-d4e8b24235ac"

# ========= DATA LAKE =========
export GLUE_DB_B="spywhisper_b_db"
export GLUE_TABLE_B="ctr_agency_b_tapes"
export CRAWLER_B="spywhisper-b-crawler"

# ========= BUCKETS =========
export RAW_BUCKET_B="spywhisper-b-raw-${ACCT_B}"
export RESULTS_BUCKET_MAIN="spywhisper-results-${ACCT_MAIN}"

# ========= PREFIXES =========
export RAW_PREFIX="raw/ctr_agency_b_tapes/"
export RESULTS_PREFIX="cleanrooms/results/"

# ========= ROLES =========
export GLUE_CRAWLER_ROLE_B="spywhisper-b-glue-crawler-role"
export CLEANROOMS_RECEIVER_ROLE_MAIN="cleanrooms-query-receiver-20260102162004"

export RESULTS_BUCKET_B="spywhisper-results-b-${ACCT_B}"
export RESULTS_PREFIX_B="cleanrooms/results/"
export MEMBERSHIP_B_ID=MEMBERSHIP_B_ID_PLACEHOLDER
