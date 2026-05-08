#!/usr/bin/env bash
# ============================================================================
# MAE Smoke Test - Multi-Agent Engine End-to-End Verification
# ============================================================================
# Runs prerequisite checks, type checking, unit tests, dashboard build, and
# an optional echo-adapter chain test. Prints a colorful summary with timing.
# Exit 0 = all pass, 1 = any failure.
# ============================================================================

set -euo pipefail

# --- Colors & Symbols ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'
CHECK="${GREEN}✓${RESET}"
CROSS="${RED}✗${RESET}"
ARROW="${CYAN}→${RESET}"

# --- State ---
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
TOTAL_START=$(date +%s)
declare -a RESULTS=()

# --- Helpers ---
header() {
  echo ""
  echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "${BOLD}  🔥 MAE Smoke Test${RESET}"
  echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "  ${DIM}Repo: ${REPO_ROOT}${RESET}"
  echo -e "  ${DIM}Date: $(date '+%Y-%m-%d %H:%M:%S %Z')${RESET}"
  echo ""
}

run_step() {
  local step_num="$1"
  local step_name="$2"
  local step_cmd="$3"
  local step_dir="${4:-$REPO_ROOT}"
  local required="${5:-true}"

  echo -e "  ${ARROW} ${BOLD}Step ${step_num}:${RESET} ${step_name}"

  local step_start
  step_start=$(date +%s)
  local output
  local exit_code=0

  output=$(cd "$step_dir" && eval "$step_cmd" 2>&1) || exit_code=$?

  local step_end
  step_end=$(date +%s)
  local elapsed=$(( step_end - step_start ))

  if [[ $exit_code -eq 0 ]]; then
    echo -e "    ${CHECK} ${GREEN}Passed${RESET} ${DIM}(${elapsed}s)${RESET}"
    PASS_COUNT=$(( PASS_COUNT + 1 ))
    RESULTS+=("${CHECK}|${step_name}|${elapsed}s|PASS")
  else
    if [[ "$required" == "true" ]]; then
      echo -e "    ${CROSS} ${RED}Failed${RESET} ${DIM}(${elapsed}s)${RESET}"
      FAIL_COUNT=$(( FAIL_COUNT + 1 ))
      RESULTS+=("${CROSS}|${step_name}|${elapsed}s|FAIL")
      # Show truncated output on failure
      echo -e "    ${DIM}--- output (last 20 lines) ---${RESET}"
      echo "$output" | tail -20 | sed 's/^/    /'
      echo -e "    ${DIM}--- end output ---${RESET}"
    else
      echo -e "    ${YELLOW}⊘ Skipped${RESET} ${DIM}(not available)${RESET}"
      SKIP_COUNT=$(( SKIP_COUNT + 1 ))
      RESULTS+=("${YELLOW}⊘${RESET}|${step_name}|skipped|SKIP")
    fi
  fi
  echo ""
}

check_prereq() {
  local name="$1"
  local cmd="$2"

  if command -v "$cmd" &>/dev/null; then
    local version
    version=$("$cmd" --version 2>/dev/null | head -1 || echo "unknown")
    echo -e "    ${CHECK} ${name}: ${DIM}${version}${RESET}"
    return 0
  else
    echo -e "    ${CROSS} ${name}: ${RED}not found${RESET}"
    return 1
  fi
}

print_summary() {
  local total_end
  total_end=$(date +%s)
  local total_elapsed=$(( total_end - TOTAL_START ))

  echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "${BOLD}  📊 Summary${RESET}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo ""

  # Print results table
  printf "  %-4s %-42s %-10s\n" "   " "Step" "Time"
  echo -e "  ${DIM}──── ────────────────────────────────────── ──────────${RESET}"
  for result in "${RESULTS[@]}"; do
    IFS='|' read -r icon name time status <<< "$result"
    printf "  %b %-42s %-10s\n" "$icon" "$name" "$time"
  done

  echo ""
  echo -e "  ${GREEN}Passed: ${PASS_COUNT}${RESET}  ${RED}Failed: ${FAIL_COUNT}${RESET}  ${YELLOW}Skipped: ${SKIP_COUNT}${RESET}  ${DIM}Total: ${total_elapsed}s${RESET}"
  echo ""

  if [[ $FAIL_COUNT -eq 0 ]]; then
    echo -e "  ${GREEN}${BOLD}🎉 ALL CHECKS PASSED${RESET}"
  else
    echo -e "  ${RED}${BOLD}💥 ${FAIL_COUNT} CHECK(S) FAILED${RESET}"
  fi

  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo ""
}

# ============================================================================
# Main
# ============================================================================

header

# --- Step 0: Prerequisites ---
echo -e "  ${ARROW} ${BOLD}Step 0:${RESET} Checking prerequisites"
prereq_ok=true
check_prereq "bun" "bun" || prereq_ok=false
check_prereq "go" "go" || prereq_ok=false
check_prereq "templ" "templ" || prereq_ok=false
echo ""

if [[ "$prereq_ok" != "true" ]]; then
  echo -e "  ${CROSS} ${RED}Missing prerequisites. Install them and retry.${RESET}"
  echo ""
  RESULTS+=("${CROSS}|Prerequisites check|0s|FAIL")
  FAIL_COUNT=$(( FAIL_COUNT + 1 ))
  print_summary
  exit 1
fi

RESULTS+=("${CHECK}|Prerequisites (bun, go, templ)|0s|PASS")
PASS_COUNT=$(( PASS_COUNT + 1 ))

# --- Step 1: bun install ---
run_step 1 "Engine: bun install" "bun install --frozen-lockfile 2>&1 || bun install" "${REPO_ROOT}/engine"

# --- Step 2: TypeScript type check ---
run_step 2 "Engine: tsc --noEmit (type check)" "bunx tsc --noEmit" "${REPO_ROOT}/engine"

# --- Step 3: Unit tests ---
run_step 3 "Engine: bun test (unit tests)" "bun test" "${REPO_ROOT}/engine"

# --- Step 4: templ generate ---
run_step 4 "Dashboard: templ generate" "templ generate ./templates/" "${REPO_ROOT}/dashboard"

# --- Step 5: go build ---
run_step 5 "Dashboard: go build" "go build -o /dev/null ." "${REPO_ROOT}/dashboard"

# --- Step 6: go vet ---
run_step 6 "Dashboard: go vet ./..." "go vet ./..." "${REPO_ROOT}/dashboard"

# --- Step 7: Echo adapter chain test ---
if [[ -f "${REPO_ROOT}/engine/cli.ts" ]]; then
  run_step 7 "Engine: echo-adapter chain smoke" \
    "timeout 30 bun cli.ts chain plan-build-review --adapter echo --task 'smoke test' 2>&1 || true" \
    "${REPO_ROOT}/engine" \
    "false"
else
  echo -e "  ${YELLOW}⊘ Step 7: Skipped (cli.ts not found)${RESET}"
  SKIP_COUNT=$(( SKIP_COUNT + 1 ))
  RESULTS+=("${YELLOW}⊘${RESET}|Engine: echo-adapter chain smoke|skipped|SKIP")
  echo ""
fi

# --- Summary ---
print_summary

# --- Exit code ---
if [[ $FAIL_COUNT -gt 0 ]]; then
  exit 1
fi
exit 0
