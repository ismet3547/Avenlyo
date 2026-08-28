#!/usr/bin/env bash
#
# Verify a one-key migration of a secret-bearing env file, without ever printing a value.
#
# Usage:
#   verify-env-migration.sh <backup> <live> <KEY> <expected-before> <expected-after>
#
# Example (run under sudo, because the live file is 0640 root-adjacent):
#   sudo deploy/scripts/verify-env-migration.sh \
#     ~/env-backup/web.env.bak /etc/avenlyo/web.env AVENLYO_API_URL 1 0
#
# It answers exactly two questions:
#
#   1. Did the named key move from <expected-before> assignments to <expected-after>?
#   2. Is every other byte of the file unchanged?
#
# Question 2 is answered by comparing the two files with that key's assignments filtered out of
# BOTH sides, so the only difference the comparison can possibly see is the one that was intended.
#
# ## Why not `diff`
#
# `diff` on two env files is not a verification, it is a disclosure. If an unintended second change
# slipped in -- a rotated key pasted into the wrong line, an editor mangling a value -- diff prints
# that secret to the terminal, into the scrollback, and into whatever the operator pastes next. So
# this compares silently with `cmp -s` and reports only fixed, source-controlled text plus counts of
# a key NAME. No value from either file is ever written to stdout or stderr.
#
# ## Why this is a script and not three lines in the runbook
#
# It was three lines in the runbook, and they were wrong:
#
#     cmp -s "$A" "$B" && echo "verified: ..." || echo "REFUSED: ..."
#
# When `cmp` fails, the `||` branch runs `echo`, `echo` succeeds, and the compound command exits 0.
# The runbook claimed the check exits non-zero on an unintended change; it exited 0 and would have
# let a scripted deploy carry straight on past a file it had just refused. A guarded `if/else` with
# an explicit failing exit is the fix, and putting it in one tested file is what stops the
# documented text and the verified behaviour drifting apart again.
set -euo pipefail

if [ "$#" -ne 5 ]; then
  printf 'usage: verify-env-migration.sh <backup> <live> <KEY> <expected-before> <expected-after>\n' >&2
  exit 2
fi

backup=$1
live=$2
key=$3
expected_before=$4
expected_after=$5

for path in "$backup" "$live"; do
  if [ ! -f "$path" ]; then
    printf 'REFUSED: a file named on the command line does not exist\n' >&2
    exit 2
  fi
done

if ! printf '%s' "$key" | grep -qE '^[A-Za-z_][A-Za-z0-9_]*$'; then
  printf 'REFUSED: the key must be a plain environment variable name\n' >&2
  exit 2
fi

# Temp files, removed on every exit path including the failing ones.
filtered_backup=$(mktemp)
filtered_live=$(mktemp)
chmod 600 "$filtered_backup" "$filtered_live"
cleanup() { rm -f "$filtered_backup" "$filtered_live"; }
trap cleanup EXIT

# `grep -c` exits 1 when the count is zero, which is a legitimate answer here, not an error.
count_in() { grep -c "^${key}=" "$1" 2>/dev/null || true; }

before=$(count_in "$backup")
after=$(count_in "$live")

if [ "$before" != "$expected_before" ] || [ "$after" != "$expected_after" ]; then
  printf 'REFUSED: %s assignment count is %s -> %s, expected %s -> %s\n' \
    "$key" "$before" "$after" "$expected_before" "$expected_after" >&2
  exit 1
fi

grep -v "^${key}=" "$backup" > "$filtered_backup" || true
grep -v "^${key}=" "$live" > "$filtered_live" || true

# Guarded if/else, never `&&`/`||` chaining: a trailing `echo` in an `||` branch succeeds and would
# hand back exit 0 from a comparison that failed.
if cmp -s "$filtered_backup" "$filtered_live"; then
  printf 'verified: only the %s assignment changed (%s -> %s)\n' "$key" "$before" "$after"
  exit 0
else
  printf 'REFUSED: something other than %s changed; restore from the backup and investigate\n' \
    "$key" >&2
  exit 1
fi
