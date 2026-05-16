#!/usr/bin/env bash
# Read the most recent trigger + quality eval result JSONs and append a
# pass/fail summary to the GitHub Actions step summary. No-ops cleanly if
# no result files are present (eval steps skipped / fork PR). Buildkite is
# retired; pre-#1372 this piped to an absent `buildkite-agent` on GHA so
# the computed table was silently discarded — the summary never reached
# the run.

set -uo pipefail

shopt -s nullglob
results_dir="evals/results"

latest_of() {
  local pattern="$1"
  local files=( "$results_dir"/$pattern )
  if [[ ${#files[@]} -eq 0 ]]; then
    return 1
  fi
  ls -t "${files[@]}" | head -1
}

summarize() {
  local file="$1"
  local label="$2"
  python3 - "$file" "$label" <<'PY'
import json, sys
path, label = sys.argv[1], sys.argv[2]
data = json.load(open(path))
results = data.get("results", data) if isinstance(data, dict) else data
total = len(results)
passed = sum(1 for r in results if r.get("passed") or r.get("status") == "pass")
failed = total - passed
pct = (100 * passed / total) if total else 0
status = ":white_check_mark:" if failed == 0 else (":warning:" if passed > total / 2 else ":x:")
print(f"| {status} {label} | {passed}/{total} ({pct:.0f}%) | {failed} failed |")
PY
}

trigger_file="$(latest_of 'trigger_*.json' || true)"
quality_file="$(latest_of 'quality_*.json' || true)"

if [[ -z "${trigger_file:-}" && -z "${quality_file:-}" ]]; then
  echo "annotate-evals: no eval result files present — skipping annotation"
  exit 0
fi

{
  echo "## :bar_chart: Skills eval results"
  echo
  echo "| Suite | Pass rate | Failures |"
  echo "|-------|-----------|----------|"
  [[ -n "${trigger_file:-}" ]] && summarize "$trigger_file" "Trigger routing"
  [[ -n "${quality_file:-}" ]] && summarize "$quality_file" "Quality"
  echo
  echo "Build SHA: \`${GITHUB_SHA:-unknown}\`"
  echo
  [[ -n "${trigger_file:-}" ]] && echo "- Trigger results: \`$(basename "$trigger_file")\`"
  [[ -n "${quality_file:-}" ]] && echo "- Quality results: \`$(basename "$quality_file")\`"
} >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"
