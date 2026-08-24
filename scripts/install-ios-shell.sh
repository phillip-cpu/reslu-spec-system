#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || -z "$1" || ${#1} -gt 160 ]]; then
  echo "Usage: bash scripts/install-ios-shell.sh <CoreDevice identifier, UDID, or device name>" >&2
  exit 2
fi

device_selector="$1"
script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
ios_root="$repo_root/ios/RESLU"

developer_dir="$(xcode-select -p 2>/dev/null || true)"
if [[ "$developer_dir" != *"Xcode.app/Contents/Developer"* && -d /Applications/Xcode.app/Contents/Developer ]]; then
  developer_dir="/Applications/Xcode.app/Contents/Developer"
fi
if [[ "$developer_dir" != *"Xcode.app/Contents/Developer"* ]]; then
  echo "Full Xcode is required." >&2
  exit 1
fi
export DEVELOPER_DIR="$developer_dir"

for command_name in jq xcodegen; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "$command_name is required." >&2
    exit 1
  fi
done
if ! xcodebuild -checkFirstLaunchStatus >/dev/null 2>&1; then
  echo "Xcode first-launch setup is incomplete. Open Xcode once and finish its setup." >&2
  exit 1
fi

work_dir="$(mktemp -d /tmp/reslu-ios-install.XXXXXX)"
derived_data="$work_dir/DerivedData"
device_json="$work_dir/devices.json"
install_json="$work_dir/install.json"
launch_json="$work_dir/launch.json"
trap 'rm -rf "$work_dir"' EXIT

xcrun devicectl list devices --timeout 20 --json-output "$device_json" >/dev/null
device_record="$(jq -c --arg selector "$device_selector" '
  [
    .result.devices[]
    | select(
        .identifier == $selector
        or .hardwareProperties.udid == $selector
        or .deviceProperties.name == $selector
      )
  ][0] // empty
' "$device_json")"
if [[ -z "$device_record" ]]; then
  echo "The requested iPhone is not paired with this Mac." >&2
  exit 1
fi

device_identifier="$(jq -r '.identifier' <<<"$device_record")"
device_udid="$(jq -r '.hardwareProperties.udid' <<<"$device_record")"
device_name="$(jq -r '.deviceProperties.name' <<<"$device_record")"
tunnel_state="$(jq -r '.connectionProperties.tunnelState // "unavailable"' <<<"$device_record")"
developer_mode="$(jq -r '.deviceProperties.developerModeStatus // "unknown"' <<<"$device_record")"

if [[ "$developer_mode" != "enabled" ]]; then
  echo "$device_name does not report Developer Mode enabled." >&2
  exit 1
fi
if [[ "$tunnel_state" != "connected" ]]; then
  echo "$device_name is paired but unavailable. Connect and unlock it, then run this command again." >&2
  exit 1
fi

bash "$repo_root/scripts/prepare-ios-webrtc.sh"
(
  cd "$ios_root"
  xcodegen generate
)

xcodebuild \
  -project "$ios_root/RESLU.xcodeproj" \
  -scheme RESLU \
  -configuration Debug \
  -destination "platform=iOS,id=$device_udid" \
  -derivedDataPath "$derived_data" \
  -allowProvisioningUpdates \
  build

app_path="$derived_data/Build/Products/Debug-iphoneos/RESLU.app"
if [[ ! -d "$app_path" ]]; then
  echo "The signed RESLU.app bundle was not produced." >&2
  exit 1
fi

xcrun devicectl device install app \
  --device "$device_identifier" \
  --timeout 120 \
  --json-output "$install_json" \
  "$app_path"

xcrun devicectl device process launch \
  --device "$device_identifier" \
  --timeout 30 \
  --terminate-existing \
  --json-output "$launch_json" \
  au.com.reslu.spec

echo "PASS — RESLU was signed, installed and launched on $device_name"
echo "Next: sign in if needed, then run the seven physical-device cases in docs/IOS-NATIVE-SHELL.md."
