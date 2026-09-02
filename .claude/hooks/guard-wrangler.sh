#!/usr/bin/env bash
#
# Production is deployed by GitHub Actions, and by nothing else (CLAUDE.md, AGENTS.md).
#
# Written after a local `wrangler deploy` reached the production `orator-web` script on
# 2026-08-29. The command was:
#
#     pnpm --filter @orator/web exec wrangler deploy --env staging
#
# Read that twice. It *names staging*. pnpm did not pass `--env` through, wrangler fell back
# to the top-level configuration block, and the top-level block is production's script name
# with the local development vars. So the obvious guard — "allow it if it says staging" —
# would have waved this exact command through, which is why the wrapper check below exists
# and comes first.
#
# Reads the PreToolUse payload on stdin, writes a permission decision on stdout.
set -euo pipefail

raw=$(jq -r '.tool_input.command // ""')

# A heredoc body is data, not a command, and this guard is about what runs.
#
# Added within a minute of the guard going live, because it blocked the commit that
# introduced it: the message quoted the deploy line that overwrote production, and a check
# over the whole string cannot tell a command from a description of one. It then blocked the
# edit that would have fixed it, for the same reason. Everything between `<<MARKER` and its
# closing line is dropped before any check below sees it — a commit message, a `cat > file`,
# a block of SQL.
cmd=$(printf '%s\n' "$raw" | awk '
  BEGIN { delim = "" }
  {
    if (delim != "") { if ($0 == delim) delim = ""; next }
    if (match($0, /<<-?[\047"]?[A-Za-z_][A-Za-z0-9_]*[\047"]?/)) {
      d = substr($0, RSTART, RLENGTH)
      sub(/^<<-?/, "", d)
      gsub(/[\047"]/, "", d)
      delim = d
    }
    print
  }
')

# Nothing to do unless wrangler is being invoked, or one of the package scripts that wrap it.
case "$cmd" in
  *wrangler*|*deploy:production*|*deploy:staging*) ;;
  *) exit 0 ;;
esac

deny() {
  jq -cn --arg reason "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

PUSH_TO_MAIN='Production is released by pushing to main — ci → staging → production runs on
every push (CLAUDE.md, "Pushing to main deploys to production"). Commit the work, get
`pnpm check` green, and push. Do not deploy from here.'

# --- 1. The wrapper, first, because it is the failure that happened -----------------------
#
# A package manager between the shell and wrangler is where `--env` goes to die. Run wrangler
# from the app directory instead:  cd apps/web && npx wrangler deploy --env staging
if printf '%s' "$cmd" | grep -Eq '(pnpm|npm|yarn|bun)[^|;&]*(exec|run|--filter)[^|;&]*wrangler[^|;&]*(deploy|rollback|secret|versions)'; then
  deny "A package manager is wrapping this wrangler command, and that is exactly how
production was overwritten on 2026-08-29: \`pnpm --filter @orator/web exec wrangler deploy
--env staging\` did not pass --env through, so wrangler read the top-level config block —
which carries production's script name and the local vars.

Run wrangler directly from the app directory instead:
  cd apps/edge && npx wrangler deploy --env staging

$PUSH_TO_MAIN"
fi

# --- 2. Things that are never the agent's call --------------------------------------------
if printf '%s' "$cmd" | grep -Eq 'wrangler[^|;&]*\brollback\b'; then
  deny "A rollback replaces the live deployment across every trigger. That is an operator
decision, not an agent's — state what needs rolling back and to which version, and let the
operator run it.

$PUSH_TO_MAIN"
fi

if printf '%s' "$cmd" | grep -Eq 'wrangler[^|;&]*\bsecret\b'; then
  deny "Secrets are the operator's column (CONTEXT.md, \"Division of responsibility\"), are
rotated by them, and never appear in the repository or in an issue. Name the secret and the
environment; do not set it."
fi

# --- 2a. Reading is not deploying, in any environment -------------------------------------
#
# `wrangler tail` against production is how a live incident gets diagnosed (CLAUDE.md names it
# as the tool for exactly that), and so are the listing commands. They name production because
# that is the thing being looked at.
#
# This block used to sit *below* the production checks, so everything it was written to permit
# was already denied by the time it ran, and a `SELECT` against the production database — the
# way a question about production gets answered — came back as "changing production
# infrastructure". A guard that blocks looking is a guard somebody turns off, so it runs first
# now, and the two checks it must not swallow (`rollback`, `secret`) are above it.
read_only=false

if printf '%s' "$cmd" | grep -Eq 'wrangler[^|;&]*\b(tail|whoami|versions list|deployments list|d1 info|d1 list|vectorize (list|get|info)|r2 bucket list|queues list|kv (namespace )?list)\b'; then
  read_only=true
fi

# `d1 execute` is the one subcommand that reads and writes through the same door, so the SQL
# decides rather than the verb. The test is deliberately blunt: a statement that changes
# anything, named anywhere on the line — in the query, in a pipeline after it, in a filename —
# is not a read. `--file` is never a read here, because the guard would have to open it, and
# what it holds can change between this check and the run.
if printf '%s' "$cmd" | grep -Eq 'wrangler[^|;&]*\bd1 execute\b' \
   && printf '%s' "$cmd" | grep -q -- '--command' \
   && ! printf '%s' "$cmd" | grep -q -- '--file' \
   && printf '%s' "$cmd" | grep -Eiq '\bselect\b' \
   && ! printf '%s' "$cmd" | grep -Eiq '\b(insert|update|delete|drop|alter|create|replace|attach|detach|vacuum|reindex|truncate|begin|commit|savepoint|pragma)\b'; then
  read_only=true
fi

# Nothing that also deploys, migrates or rotates a secret rides along in the same command.
if [ "$read_only" = true ] \
   && ! printf '%s' "$cmd" | grep -Eq 'wrangler[^|;&]*\b(deploy|rollback|secret|migrations apply)\b'; then
  exit 0
fi

if printf '%s' "$cmd" | grep -q -- '--env production'; then
  deny "AGENTS.md, \"Not without explicit instruction\": changing production infrastructure
and applying migrations to production need an explicit instruction naming the environment,
and even then production is released through GitHub Actions.

$PUSH_TO_MAIN"
fi

# --- 2c. The production package script, which never says "wrangler" ------------------------
#
# `pnpm --filter @orator/web deploy:production` releases production and contains none of the
# words the checks around it look for. The scripts are the *correct* way to deploy — the
# staging one is what should be used — so only the production one is stopped here.
if printf '%s' "$cmd" | grep -q 'deploy:production'; then
  deny "\`deploy:production\` releases production directly, bypassing the release path.

$PUSH_TO_MAIN"
fi

# --- 3. A production resource named outright ----------------------------------------------
#
# Staging names are removed first, so `orator-articles-staging` does not read as a hit on
# `orator-articles`. `orator-space` is the repository directory and is deliberately not in
# the list — it appears in every absolute path in this checkout.
stripped=$(printf '%s' "$cmd" | sed -E 's/orator[-_][a-z-]*[-_]staging//g')
if printf '%s' "$stripped" | grep -Eq 'orator-(web|edge|prod|articles|content|media|assets|events)\b|orator_metrics\b'; then
  deny "This names a production resource. Staging carries the -staging suffix; anything
without it is the live deployment.

$PUSH_TO_MAIN"
fi

# --- 3a. The documentation site, which has no staging to fall back to ---------------------
#
# ADR 0013: apps/docs is one environment and it is production. So check 4 below — "name
# --env staging" — is advice that cannot be followed here, and a guard that asks for an
# impossible flag gets read as broken and then ignored. Named separately, with the reason.
if printf '%s' "$cmd" | grep -Eq 'wrangler[^|;&]*\bdeploy\b' \
   && printf '%s' "$cmd" | grep -Eq 'orator-docs|apps/docs'; then
  if printf '%s' "$cmd" | grep -q -- '--dry-run'; then exit 0; fi
  deny "The documentation site has one environment and it is production (ADR 0013). There is
no --env staging to name here, and this would deploy docs.orator.space from a laptop.

Use --dry-run to check what this would upload.

$PUSH_TO_MAIN"
fi

# --- 4. Anything else that mutates a deployed environment ----------------------------------
mutating=false
if printf '%s' "$cmd" | grep -Eq 'wrangler[^|;&]*\bdeploy\b'; then mutating=true; fi
if printf '%s' "$cmd" | grep -Eq 'wrangler[^|;&]*\bd1\b[^|;&]*\b(migrations apply|execute)\b' \
   && printf '%s' "$cmd" | grep -q -- '--remote'; then mutating=true; fi

if [ "$mutating" = true ]; then
  # `--dry-run` builds and prints the bindings without uploading anything, which is how the
  # configuration gets checked. It is the one safe shape of a deploy command.
  if printf '%s' "$cmd" | grep -q -- '--dry-run'; then exit 0; fi

  if ! printf '%s' "$cmd" | grep -q -- '--env staging'; then
    deny "A wrangler command that writes to a deployed environment must name staging
explicitly: --env staging. Without it wrangler reads the top-level configuration block, which
is production's script name with the local development vars — the shape that overwrote
production on 2026-08-29.

Use --dry-run to check what a deploy would bind.

$PUSH_TO_MAIN"
  fi
fi

exit 0
