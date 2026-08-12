#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
ios_root="$repo_root/ios/RESLU"

developer_dir="$(xcode-select -p 2>/dev/null || true)"
if [[ "$developer_dir" != *"Xcode.app/Contents/Developer"* ]]; then
  echo "Full Xcode is required. Install and open Xcode, then select it with xcode-select." >&2
  exit 1
fi

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "XcodeGen is required. Install it with: brew install xcodegen" >&2
  exit 1
fi

(
  cd "$ios_root"
  xcodegen generate
)

derived_data="$(mktemp -d /tmp/reslu-ios-derived-data.XXXXXX)"
trap 'rm -rf "$derived_data"' EXIT

xcodebuild \
  -project "$ios_root/RESLU.xcodeproj" \
  -scheme RESLU \
  -configuration Debug \
  -sdk iphonesimulator \
  -derivedDataPath "$derived_data" \
  CODE_SIGNING_ALLOWED=NO \
  build

echo "PASS — RESLU iOS shell generated and compiled for the iPhone simulator"
