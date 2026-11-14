#!/usr/bin/env bash
# Reports browser or test processes started from this project. It never kills
# anything: cleanup is the responsibility of the code under test.
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

leaks="$(
  ps -eo pid=,args= | awk -v project="$project_dir" '
    /check-leaks\.sh/ { next }
    /awk -v project/ { next }
    /firefox-esr|geckodriver/ {
      if (index($0, project) > 0 || index($0, ".tmp/test-") > 0) { print; next }
    }
    /(tsx|node)/ && /--test/ {
      if (index($0, project) > 0) { print }
    }
  '
)"

if [ -n "$leaks" ]; then
  echo "Leaked processes found:"
  echo "$leaks"
  exit 1
fi

echo "No leaked firefox-esr, geckodriver or test processes from $project_dir"
