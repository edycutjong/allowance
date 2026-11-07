#!/usr/bin/env bash
# Semantic version from conventional commits since the last v* tag.
#   feat!: / BREAKING CHANGE → major · feat → minor · fix/perf → patch · docs/chore/test/ci/... → no release
# Usage: scripts/release.sh            → prints "next=vX.Y.Z" and "bump=<kind>" (or "skip=true")
#        scripts/release.sh --notes    → prints Markdown release notes grouped by type
set -euo pipefail
LAST=${FROM_TAG:-$(git describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null || echo "")}
RANGE=${LAST:+$LAST..HEAD}
SUBJECTS=$(git log --no-merges --format='%s' $RANGE)
BODIES=$(git log --no-merges --format='%B' $RANGE)

if [ "${1:-}" = "--notes" ]; then
  REPO_URL=${REPO_URL:-}
  section() { # $1 title, $2 regex
    local lines; lines=$(git log --no-merges --format='%h%x09%s' $RANGE | awk -F'\t' -v re="$2" '$2 ~ re' || true)
    [ -z "$lines" ] && return 0
    echo "### $1"
    while IFS=$'\t' read -r sha subj; do
      if [ -n "$REPO_URL" ]; then echo "- ${subj} ([\`${sha}\`](${REPO_URL}/commit/${sha}))"; else echo "- ${subj} (\`${sha}\`)"; fi
    done <<< "$lines"
    echo
  }
  section "⚠️ Breaking changes" '^[a-z]+(\(.+\))?!:'
  section "✨ Features" '^feat(\(.+\))?:'
  section "🐛 Fixes" '^fix(\(.+\))?:'
  section "⚡ Performance" '^perf(\(.+\))?:'
  section "🧪 Tests" '^test(\(.+\))?:'
  section "📝 Docs" '^docs(\(.+\))?:'
  section "🔧 CI and chores" '^(ci|chore|build|refactor|style|polish)(\(.+\))?:'
  echo "**Full diff:** ${REPO_URL:+${REPO_URL}/compare/}${LAST:-first commit}...HEAD"
  exit 0
fi

[ -z "$(echo "$SUBJECTS" | tr -d '[:space:]')" ] && { echo "skip=true"; exit 0; }
BUMP=none
echo "$SUBJECTS" | grep -qE '^[a-z]+(\(.+\))?!:' && BUMP=major
echo "$BODIES" | grep -qE '^BREAKING CHANGE:' && BUMP=major
[ "$BUMP" = none ] && echo "$SUBJECTS" | grep -qE '^feat(\(.+\))?:' && BUMP=minor
[ "$BUMP" = none ] && echo "$SUBJECTS" | grep -qE '^(fix|perf)(\(.+\))?:' && BUMP=patch
[ "$BUMP" = none ] && { echo "skip=true"; exit 0; }
CUR=${LAST#v}; CUR=${CUR:-0.0.0}
IFS=. read -r MA MI PA <<< "$CUR"
case "$BUMP" in
  major) MA=$((MA+1)); MI=0; PA=0 ;;
  minor) MI=$((MI+1)); PA=0 ;;
  patch) PA=$((PA+1)) ;;
esac
echo "skip=false"
echo "bump=$BUMP"
echo "next=v${MA}.${MI}.${PA}"
