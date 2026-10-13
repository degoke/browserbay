#!/usr/bin/env bash
# Is this exact package version already on the registry this job is set up for?
#
#   scripts/npm-published.sh @scope/name@1.2.3
#
# Exit 0: it is. Exit 1: it is not (the registry answered "not found"). Exit 2: the registry could not be asked
# (a network error, a 5xx), so nothing is known. A caller that publishes on 1 and stops on 2 can be re-run safely: a
# blip is an error to retry, never taken as "not published".
set -u

if out=$(npm view "$1" version 2>&1); then
  exit 0
fi
if grep -q 'E404' <<<"$out"; then
  exit 1
fi
echo "$out" >&2
exit 2
