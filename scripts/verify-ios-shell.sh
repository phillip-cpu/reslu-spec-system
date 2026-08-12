#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
ios_root="$repo_root/ios/RESLU"

developer_dir="$(xcode-select -p 2>/dev/null || true)"
if [[ "$developer_dir" != *"Xcode.app/Contents/Developer"* && -d /Applications/Xcode.app/Contents/Developer ]]; then
  developer_dir="/Applications/Xcode.app/Contents/Developer"
fi
if [[ "$developer_dir" != *"Xcode.app/Contents/Developer"* ]]; then
  echo "Full Xcode is required. Install and open Xcode once to finish setup." >&2
  exit 1
fi
export DEVELOPER_DIR="$developer_dir"
if ! xcodebuild -checkFirstLaunchStatus >/dev/null 2>&1; then
  echo "Xcode is installed but first-launch setup is incomplete. Open Xcode, accept its licence and install the requested components." >&2
  exit 1
fi

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "XcodeGen is required. Install it with: brew install xcodegen" >&2
  exit 1
fi

bash "$repo_root/scripts/prepare-ios-webrtc.sh"

sdk_path="$(xcrun --sdk iphoneos --show-sdk-path)"
module_cache="$(mktemp -d /tmp/reslu-swift-module-cache.XXXXXX)"
swiftc \
  -typecheck \
  -parse-as-library \
  -target arm64-apple-ios16.0 \
  -sdk "$sdk_path" \
  -F "$ios_root/Packages/WebRTC/WebRTC.xcframework/ios-arm64" \
  -module-cache-path "$module_cache" \
  "$ios_root"/RESLU/*.swift

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
  -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$derived_data" \
  CODE_SIGNING_ALLOWED=NO \
  build

echo "PASS — RESLU iOS shell generated and compiled for a generic iPhone"
