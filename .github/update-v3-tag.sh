#!/usr/bin/env bash

set -euo pipefail

remote="${1:-origin}"

latest_v3_tag="$(git tag --list 'v3.*' --sort=-v:refname | head -n 1)"

if [ -z "$latest_v3_tag" ]; then
  echo "No v3.x.x tag found."
  exit 1
fi

target_sha="$(git rev-list -n 1 "$latest_v3_tag")"
current_sha="$(git rev-parse -q --verify refs/tags/v3^{commit} || true)"

if [ "$current_sha" = "$target_sha" ]; then
  echo "v3 already points to $latest_v3_tag ($target_sha)."
  exit 0
fi

git fetch --tags "$remote"
git tag -f v3 "$target_sha"
git push --force "$remote" refs/tags/v3

echo "Updated v3 to point to $latest_v3_tag ($target_sha)."
