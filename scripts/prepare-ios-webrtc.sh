#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
package_root="$repo_root/ios/RESLU/Packages/WebRTC"
framework="$package_root/WebRTC.xcframework"
marker="$package_root/.artifact-151.0.0.sha256"
archive="$package_root/WebRTC-M151.xcframework.zip"
artifact_url="https://github.com/stasel/WebRTC/releases/download/151.0.0/WebRTC-M151.xcframework.zip"
expected_checksum="64a218fad3d84a0d783321aa9a1eec58ca266ac7879123f86b0b44b703b7d8dc"

mkdir -p "$package_root"
if [[ -d "$framework" && -f "$marker" && "$(tr -d '[:space:]' < "$marker")" == "$expected_checksum" ]]; then
  echo "WebRTC 151.0.0 is already prepared and checksum-pinned."
  exit 0
fi

echo "Downloading pinned WebRTC 151.0.0 (resumable, 42.5 MB)..."
curl \
  --location \
  --fail \
  --retry 8 \
  --retry-all-errors \
  --retry-delay 2 \
  --connect-timeout 20 \
  --continue-at - \
  --output "$archive" \
  "$artifact_url"

actual_checksum="$(shasum -a 256 "$archive" | awk '{print $1}')"
if [[ "$actual_checksum" != "$expected_checksum" ]]; then
  rm -f "$archive"
  echo "WebRTC checksum mismatch; the downloaded archive was discarded." >&2
  exit 1
fi

extract_root="$(mktemp -d /tmp/reslu-webrtc-extract.XXXXXX)"
trap 'rm -rf "$extract_root"' EXIT
ditto -x -k "$archive" "$extract_root"
extracted_framework="$(find "$extract_root" -maxdepth 2 -type d -name 'WebRTC.xcframework' -print -quit)"
if [[ -z "$extracted_framework" ]]; then
  echo "The verified WebRTC archive did not contain WebRTC.xcframework." >&2
  exit 1
fi

if [[ "$framework" != "$package_root/WebRTC.xcframework" ]]; then
  echo "Refusing to replace an unexpected WebRTC target path." >&2
  exit 1
fi
rm -rf "$framework"
mv "$extracted_framework" "$framework"
printf '%s\n' "$expected_checksum" > "$marker"
rm -f "$archive"
echo "PASS — pinned WebRTC 151.0.0 prepared with the published SHA-256"
