#!/usr/bin/env bash
# For a dry-run merge of upstream/main into main, find files that merge
# CLEANLY (no conflict markers) but whose telemetry attribute names change
# from our app.* to upstream's demo.* -- i.e. silent renames that no
# conflict, test, or compiler will catch, but that break Honeycomb queries.
set -u
cd "$(git rev-parse --show-toplevel)"

MT=$(mktemp)
git merge-tree --write-tree --name-only main upstream/main > "$MT" || true
TREE=$(head -1 "$MT")
awk 'NR>1{if($0==""){exit} print}' "$MT" > "$MT.conflicts"

echo "merged tree: $TREE"
echo "conflicted files: $(wc -l < "$MT.conflicts")"
echo

# Every file that currently carries an app.* telemetry name.
git grep -lE "['\"]app\.[a-z_.]+['\"]" main -- src/ \
  | sed 's|^main:||' | sort > "$MT.appfiles"

echo "files in ours carrying app.* names: $(wc -l < "$MT.appfiles")"
echo

clean_bad=0
printf '%-60s %s\n' "FILE (clean merge, but names changed)" "app.*->demo.*"
while read -r f; do
  grep -qxF "$f" "$MT.conflicts" && continue   # conflicted: human will see it
  blob=$(git ls-tree "$TREE" "$f" | awk '{print $3}')
  [ -z "$blob" ] && { printf '%-60s %s\n' "$f" "DELETED BY MERGE"; continue; }
  ours=$(git grep -hoE "['\"]app\.[a-z_.]+['\"]" main -- "$f" | sort -u | wc -l | tr -d ' ')
  now_app=$(git cat-file blob "$blob" | grep -oE "['\"]app\.[a-z_.]+['\"]" | sort -u | wc -l | tr -d ' ')
  now_demo=$(git cat-file blob "$blob" | grep -oE "['\"]demo\.[a-z_.]+['\"]" | sort -u | wc -l | tr -d ' ')
  if [ "$now_app" -lt "$ours" ] || [ "$now_demo" -gt 0 ]; then
    printf '%-60s %s\n' "$f" "ours=$ours after=$now_app demo=$now_demo"
    clean_bad=$((clean_bad + 1))
  fi
done < "$MT.appfiles"

echo
echo "clean-merge files with silently changed telemetry names: $clean_bad"
rm -f "$MT" "$MT.conflicts" "$MT.appfiles"
