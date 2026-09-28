#!/usr/bin/env bash
# Switch the local cluster ($USER-local) between the slow-login story's two states.
#
#   scripts/login-story-local.sh broken    # Release B: "Remove stale feature flags" (non-Globex SSO logins take ~10s)
#   scripts/login-story-local.sh healthy   # main: Release A only (status check targeted at Globex)
#   scripts/login-story-local.sh status    # which state is the local auth pod running?
#
# broken/healthy check out the ref into a detached worktree under .claude/worktrees/login-story-<state>,
# then run `./run auth frontend` from there. Only auth and frontend differ between the states; the flag file
# rides along on the skaffold hook. Like ./run, it blocks on the port-forward until you Ctrl+C.
#
# Once the deploy lands it:
#   - restarts flagd and auth: the hook updates flagd's ConfigMap but flagd only reads it at pod start, and auth
#     caches STATIC flag results across flagd restarts.
#   - posts a Honeycomb deploy marker. ./run posts its own only when skaffold exits (Ctrl+C), which can be long after
#     the latency changed.
#
# Stops any skaffold already running, since a second one fights over the port-forwards.
#
# Override the refs with BROKEN_REF / HEALTHY_REF.

set -euo pipefail

BROKEN_REF="${BROKEN_REF:-jessitron/remove-stale-flags}"
HEALTHY_REF="${HEALTHY_REF:-main}"
NAMESPACE="${USER}-local"
export AWS_PROFILE="${AWS_PROFILE:-devrel-sandbox}"

REPO="$(cd "$(git -C "$(dirname "$0")" rev-parse --path-format=absolute --git-common-dir)/.." && pwd)"

usage() {
  sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

# The commit a local auth image was built from. Skaffold tags images with `git describe --tags`:
# <tag>-<n>-g<sha>, or just <tag> when the commit is the tag, plus -dirty for uncommitted changes.
image_commit() {
  local tag="${1%%@*}"
  tag="${tag##*:}"
  tag="${tag%-dirty}"
  if [[ "$tag" =~ -g([0-9a-f]{7,})$ ]]; then
    echo "${BASH_REMATCH[1]}"
  else
    git -C "$REPO" rev-parse --short "$tag^{commit}" 2>/dev/null || true
  fi
}

status() {
  local image sha
  image=$(kubectl -n "$NAMESPACE" get deploy auth -o jsonpath='{.spec.template.spec.containers[?(@.name=="auth")].image}')
  echo "auth image: $image"
  if [[ "$image" != *localdemo/* ]]; then
    echo "state: healthy (released image, not a local build)"
    return
  fi
  sha=$(image_commit "$image")
  if [[ -z "$sha" ]]; then
    echo "state: unknown (can't tell which commit built it)"
  elif git -C "$REPO" merge-base --is-ancestor "$BROKEN_REF" "$sha" 2>/dev/null; then
    echo "state: broken (built from $sha, which includes $BROKEN_REF)"
  elif git -C "$REPO" merge-base --is-ancestor "$sha" "$HEALTHY_REF" 2>/dev/null; then
    echo "state: healthy (built from $sha, on $HEALTHY_REF)"
  else
    echo "state: unknown (built from $sha)"
  fi
}

STATE="${1:-}"
case "$STATE" in
  broken)  REF="$BROKEN_REF" ;;
  healthy) REF="$HEALTHY_REF" ;;
  status)  status; exit 0 ;;
  *)       usage ;;
esac

WORKTREE="$REPO/.claude/worktrees/login-story-$STATE"
if [[ -d "$WORKTREE" ]]; then
  echo "Updating $WORKTREE to $REF..."
  git -C "$WORKTREE" checkout --quiet --detach "$REF"
else
  echo "Checking out $REF into $WORKTREE..."
  git -C "$REPO" worktree add --quiet --detach "$WORKTREE" "$REF"
fi
COMMIT="$(git -C "$WORKTREE" log --oneline -1)"
echo "$COMMIT"

# .skaffold.env is gitignored, so worktrees don't get it.
if [[ -f "$REPO/.skaffold.env" ]]; then
  cp "$REPO/.skaffold.env" "$WORKTREE/.skaffold.env"
fi

if pgrep -f 'skaffold run' >/dev/null; then
  echo "Stopping the skaffold that's already running..."
  pkill -f 'skaffold run' || true
  while pgrep -f 'skaffold run' >/dev/null; do sleep 1; done
fi

# Outside the worktree, so the build isn't tagged -dirty.
LOG="$WORKTREE.log"
: >"$LOG"

# Once the deploy is up, restart flagd and auth so the flag state matches the code, then mark it.
(
  until grep -q 'Press Ctrl+C to exit' "$LOG" 2>/dev/null; do sleep 2; done
  echo "==> Deployed. Restarting flagd and auth so flags match $STATE..."
  kubectl -n "$NAMESPACE" rollout restart deploy/flagd deploy/auth >/dev/null
  kubectl -n "$NAMESPACE" rollout status deploy/flagd --timeout=180s >/dev/null
  kubectl -n "$NAMESPACE" rollout status deploy/auth --timeout=180s >/dev/null
  (
    cd "$WORKTREE"
    set -a
    [[ -f .skaffold.env ]] && eval "$(cat .skaffold.env)"
    set +a
    HONEYCOMB_MARKERS_API_KEY="${HONEYCOMB_MARKERS_API_KEY:-${HONEYCOMB_API_KEY:-}}" \
      scripts/create-local-deploy-marker.sh "login story: $STATE ($COMMIT) -> $NAMESPACE" >/dev/null
  ) && echo "==> Posted deploy marker." || echo "==> Couldn't post the deploy marker." >&2
  echo "==> Local is now $STATE ($COMMIT). Ctrl+C stops the port-forward."
) &
WATCHER=$!
trap 'kill $WATCHER 2>/dev/null || true' EXIT

cd "$WORKTREE"
./run auth frontend 2>&1 | tee -i -a "$LOG"
