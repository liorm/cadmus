#!/usr/bin/env bash
#
# run-reviews.sh — Headless reviewer runner using `agy`
#
# Usage:
#   ./docs/plans/run-reviews.sh               # Run all review-*.md sequentially
#   ./docs/plans/run-reviews.sh 01            # Run only review-01.md
#   ./docs/plans/run-reviews.sh 01 02         # Run review-01.md and review-02.md
#   ./docs/plans/run-reviews.sh --force       # Re-run even if results exist
#   ./docs/plans/run-reviews.sh --model <m>   # Override model for agy
#   ./docs/plans/run-reviews.sh --effort <e>  # Set reasoning effort (low|medium|high|xhigh|max)
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

FORCE=false
MODEL=""
EFFORT=""
TARGETS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -f|--force)
      FORCE=true
      shift
      ;;
    -m|--model)
      MODEL="$2"
      shift 2
      ;;
    -e|--effort)
      EFFORT="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 [options] [review-numbers...]"
      echo ""
      echo "Options:"
      echo "  -f, --force         Re-run even if results file already exists"
      echo "  -m, --model <name>  Specify model for agy CLI"
      echo "  -e, --effort <lvl>  Specify reasoning effort (low|medium|high|xhigh|max)"
      echo "  -h, --help          Show this help message"
      echo ""
      echo "Examples:"
      echo "  $0                  # Run all reviews (01 to 08)"
      echo "  $0 01 03            # Run only review-01.md and review-03.md"
      echo "  $0 --force 02       # Force re-run of review-02.md"
      exit 0
      ;;
    *)
      # Positional argument: e.g. "01", "1", or "review-01.md"
      ARG="$1"
      if [[ "$ARG" =~ ^[0-9]+$ ]]; then
        TARGETS+=("review-$(printf "%02d" "$ARG").md")
      elif [[ "$ARG" =~ ^review-[0-9]+\.md$ ]]; then
        TARGETS+=("$ARG")
      else
        echo "Error: Unrecognized argument '$ARG'" >&2
        exit 1
      fi
      shift
      ;;
  esac
done

# If no specific targets provided, find all review-*.md in SCRIPT_DIR
if [[ ${#TARGETS[@]} -eq 0 ]]; then
  mapfile -t TARGETS < <(find "${SCRIPT_DIR}" -maxdepth 1 -name "review-*.md" -not -name "*results*" | sort)
fi

echo "=========================================================="
echo " Starting Headless Plan Reviews via 'agy'"
echo " Workspace:   ${WORKSPACE_ROOT}"
echo " Review Dir:  ${SCRIPT_DIR}"
echo " Total Tasks: ${#TARGETS[@]}"
if [[ -n "${MODEL}" ]]; then echo " Model:       ${MODEL}"; fi
if [[ -n "${EFFORT}" ]]; then echo " Effort:      ${EFFORT}"; fi
echo "=========================================================="
echo ""

cd "${WORKSPACE_ROOT}"

for ITEM in "${TARGETS[@]}"; do
  if [[ "$ITEM" = /* ]]; then
    REVIEW_PATH="$ITEM"
  else
    REVIEW_PATH="${SCRIPT_DIR}/${ITEM}"
  fi

  REVIEW_FILENAME="$(basename "${REVIEW_PATH}")"
  BASE_NAME="${REVIEW_FILENAME%.md}"
  RESULTS_PATH="${SCRIPT_DIR}/${BASE_NAME}-results.md"
  RESULTS_FILENAME="$(basename "${RESULTS_PATH}")"

  if [[ ! -f "${REVIEW_PATH}" ]]; then
    echo "[-] Warning: Instruction file '${REVIEW_PATH}' not found. Skipping."
    continue
  fi

  echo "----------------------------------------------------------"
  echo "[*] Task: ${REVIEW_FILENAME}"
  echo "    Instructions: ${REVIEW_PATH}"
  echo "    Target Output: ${RESULTS_PATH}"

  if [[ -f "${RESULTS_PATH}" && -s "${RESULTS_PATH}" && "${FORCE}" = false ]]; then
    echo "    [SKIP] Output file already exists and is non-empty. Use --force to re-run."
    echo ""
    continue
  fi

  # Formulate prompt for agy
  PROMPT="You are an autonomous code and design reviewer.
Please execute the review specified in the instruction file:
${REVIEW_PATH}

Read that instruction file thoroughly, examine all referenced plan documents in docs/plans/tools-env/ and relevant codebase files in src/, and write your complete, detailed findings directly to:
${RESULTS_PATH}

Important:
1. Follow the required output format and checklists in ${REVIEW_FILENAME}.
2. Do NOT edit any codebase files or plan documents.
3. Only create/write the review results to ${RESULTS_FILENAME}."

  CMD=("agy" "-p" "${PROMPT}" "--dangerously-skip-permissions")
  if [[ -n "${MODEL}" ]]; then
    CMD+=("--model" "${MODEL}")
  fi
  if [[ -n "${EFFORT}" ]]; then
    CMD+=("--effort" "${EFFORT}")
  fi

  echo "    [RUN] Launching agy headless..."
  START_TIME=$(date +%s)

  set +e
  "${CMD[@]}"
  EXIT_CODE=$?
  set -e

  END_TIME=$(date +%s)
  DURATION=$((END_TIME - START_TIME))

  if [[ $EXIT_CODE -eq 0 && -f "${RESULTS_PATH}" && -s "${RESULTS_PATH}" ]]; then
    echo "    [OK] Review finished successfully in ${DURATION}s."
    echo "    Output saved to: ${RESULTS_PATH}"
  else
    echo "    [!] Error: Review process exited with code ${EXIT_CODE} or output file was not generated."
  fi
  echo ""
done

echo "=========================================================="
echo " All review tasks processed."
echo "=========================================================="
