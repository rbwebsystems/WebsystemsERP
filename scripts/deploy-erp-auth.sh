#!/usr/bin/env bash
# issueAuthToken + Firestore qaydaları + hosting (firebase.json üzrə).
# Layihə: `firebase login` və kataloqda .firebaserc və ya `firebase use` ilə seçilmiş layihə.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

if ! command -v firebase >/dev/null 2>&1; then
  echo "firebase CLI tapılmadı: npm i -g firebase-tools"
  exit 1
fi

echo "Deploy: functions:issueAuthToken, firestore:rules, hosting"
firebase deploy --only "functions:issueAuthToken,firestore:rules,hosting"
