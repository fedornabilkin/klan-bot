#!/usr/bin/env bash
# Called after both release pointers are committed, under this component's deploy lock.
set -euo pipefail
root=${1:?Missing deployment root}
component=${root##*/}
[[ "$component" == bot ]]
registry="ghcr.io/fedornabilkin/klan-$component"
declare -A keep=()
for pointer in current previous; do
  if [[ "$pointer" == previous && ! -e "$root/$pointer" && ! -L "$root/$pointer" ]]; then continue; fi
  release=$(realpath -e -- "$root/$pointer")
  [[ -L "$root/$pointer" && "${release%/*}" == "$root/releases" ]]
  ref=$(cat -- "$release/image-ref")
  id=$(docker image inspect --format '{{.Id}}' "$ref")
  [[ "$id" =~ ^sha256:[a-f0-9]{64}$ ]]
  keep[$id]=1
done
images=$(docker image ls --digests --no-trunc --format '{{.Repository}} {{.Tag}} {{.Digest}} {{.ID}}')
while read -r repository tag digest id; do
  [[ "$id" =~ ^sha256:[a-f0-9]{64}$ ]] || continue
  [[ ! ${keep[$id]+protected} ]] || continue
  if [[ "$repository" == "$registry" && "$tag" == '<none>' && "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    ref="$repository@$digest"
  else
    continue
  fi
  containers=$(docker container ls --all --quiet --filter "ancestor=$id")
  [[ -n "$containers" ]] || docker image rm "$ref"
done <<< "$images"
