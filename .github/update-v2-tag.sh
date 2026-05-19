#!/usr/bin/env bash

set -euo pipefail

remote="${1:-origin}"

latest_v2_tag="$(git tag --list 'v2.*' --sort=-v:refname | head -n 1)"

if [ -z "$latest_v2_tag" ]; then
  echo "No v2.x.x tag found."
  exit 1
fi

target_sha="$(git rev-list -n 1 "$latest_v2_tag")"
current_sha="$(git rev-parse -q --verify refs/tags/v2^{commit} || true)"

if [ "$current_sha" = "$target_sha" ]; then
  echo "v2 already points to $latest_v2_tag ($target_sha)."
  exit 0
fi

git fetch --tags "$remote"
git tag -f v2 "$target_sha"
git push --force "$remote" refs/tags/v2

echo "Updated v2 to point to $latest_v2_tag ($target_sha)."
