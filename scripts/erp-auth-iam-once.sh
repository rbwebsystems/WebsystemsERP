#!/usr/bin/env bash
# Bir dəfəlik: Cloud Functions (Gen2) runtime hesabına App Engine default SA üzrə
# "Service Account Token Creator" verir — Firebase Admin custom token imzası (signBlob) üçün.
#
# Tələblər: gcloud quraşdırılmış, `gcloud auth login` və `gcloud config set project ...`
#
# İstifadə:
#   ./scripts/erp-auth-iam-once.sh YOUR_FIREBASE_PROJECT_ID
# və ya:
#   export FIREBASE_PROJECT_ID=YOUR_FIREBASE_PROJECT_ID
#   ./scripts/erp-auth-iam-once.sh

set -euo pipefail

PROJECT_ID="${1:-${FIREBASE_PROJECT_ID:-}}"
if [[ -z "${PROJECT_ID}" ]]; then
  echo "Layihə ID verin: ./scripts/erp-auth-iam-once.sh my-firebase-project-id"
  exit 1
fi

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud tapılmadı. Google Cloud SDK quraşdırın: https://cloud.google.com/sdk/docs/install"
  exit 1
fi

NUM="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
RUNTIME_SA="${NUM}-compute@developer.gserviceaccount.com"
APPSPOT_SA="${PROJECT_ID}@appspot.gserviceaccount.com"

echo "Layihə:     ${PROJECT_ID}"
echo "Runtime SA: ${RUNTIME_SA}"
echo "App Engine: ${APPSPOT_SA}"
echo "→ ${RUNTIME_SA} üçün ${APPSPOT_SA} üzərində roles/iam.serviceAccountTokenCreator əlavə edilir..."

gcloud iam service-accounts add-iam-policy-binding "${APPSPOT_SA}" \
  --project="${PROJECT_ID}" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/iam.serviceAccountTokenCreator"

echo "Hazır. İndi: firebase deploy --only functions:issueAuthToken"
echo "Əgər xəta alınsa, Firebase Console → Project settings → Service accounts səhifəsindəki"
echo "firebase-adminsdk-...@...iam.gserviceaccount.com ünvanını APPSPOT_SA əvəzinə yoxlayın."
