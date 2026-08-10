#!/usr/bin/env bash
set -euo pipefail

if (( $# != 2 )); then
  echo "usage: $0 NEW_TARGET_DIRECTORY PRIVATE_DENYLIST" >&2
  exit 64
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
source_root=$(CDPATH= cd -- "$script_dir/.." && pwd -P)
target=$1
denylist=$2
if [[ ! -f "$denylist" || ! -r "$denylist" ]]; then
  echo "private denylist does not exist: $denylist" >&2
  exit 66
fi
manifest_snapshot=$(mktemp)
denylist_snapshot=$(mktemp)
trap 'rm -f -- "$manifest_snapshot" "$denylist_snapshot"' EXIT
cp -pP -- "$source_root/release/public-files.txt" "$manifest_snapshot"
cp -L -- "$denylist" "$denylist_snapshot"

node "$source_root/scripts/release-audit.mjs" --denylist "$denylist_snapshot"
if ! cmp -s -- "$manifest_snapshot" "$source_root/release/public-files.txt"; then
  echo "public manifest changed during audit" >&2
  exit 66
fi

if [[ -e "$target" ]]; then
  echo "target must not exist: $target" >&2
  exit 65
fi
mkdir -m 700 -- "$target"

target_root=$(CDPATH= cd -- "$target" && pwd -P)
if [[ "$target_root" == "$source_root" || "$target_root" == "$source_root/"* ]]; then
  echo "target must be outside the source repository" >&2
  exit 65
fi

while IFS= read -r path; do
  [[ -n "$path" ]] || continue
  install -d -- "$target_root/$(dirname -- "$path")"
  if [[ "$path" == "release/public-files.txt" ]]; then
    install -m 644 -- "$manifest_snapshot" "$target_root/$path"
  else
    cp -pP -- "$source_root/$path" "$target_root/$path"
  fi
done < "$manifest_snapshot"

git -C "$target_root" init --quiet --initial-branch=main
git -C "$target_root" config user.name "Salon Reservation OSS Release"
git -C "$target_root" config user.email "salon-reservation-oss@users.noreply.github.com"
git -C "$target_root" config core.hooksPath /dev/null
git -C "$target_root" add --all
git -C "$target_root" commit --quiet --no-gpg-sign --message "release: Salon Reservation OSS v0.2.0"

node "$target_root/scripts/release-audit.mjs" --public-tree --denylist "$denylist_snapshot"

echo "assembled and committed public release candidate: $target_root"
