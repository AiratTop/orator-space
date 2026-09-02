#!/usr/bin/env bash
#
# Runs guard-wrangler.sh against every case in guard-wrangler.cases.json.
#
# The fixture predates this and had nothing that ran it, which is how a guard drifts: the
# cases are the record of which shapes are denied and why, and a record nobody executes is a
# comment. Run it after touching either file.
#
#   bash .claude/hooks/guard-wrangler.test.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
guard="$here/guard-wrangler.sh"
cases="$here/guard-wrangler.cases.json"

total=0
failed=0

# The command travels base64-encoded: the first case is a heredoc, and a case with a newline
# in it is exactly the one worth keeping — it is the shape that broke this guard on day one.
while IFS=$'\t' read -r want encoded; do
  total=$((total + 1))
  cmd=$(printf '%s' "$encoded" | base64 --decode)
  payload=$(jq -cn --arg cmd "$cmd" '{tool_input: {command: $cmd}}')
  out=$(printf '%s' "$payload" | "$guard")
  got=allow
  case "$out" in *'"deny"'*) got=deny ;; esac
  if [ "$got" != "$want" ]; then
    failed=$((failed + 1))
    printf 'want %-5s got %-5s  %s\n' "$want" "$got" "${cmd:0:120}"
  fi
done < <(jq -r '.[] | [.[0], (.[1] | @base64)] | @tsv' "$cases")

if [ "$failed" -gt 0 ]; then
  printf '\nguard-wrangler: %d of %d cases wrong\n' "$failed" "$total"
  exit 1
fi

printf 'guard-wrangler: ok — %d cases\n' "$total"
