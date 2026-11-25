#!/usr/bin/env bash
# Runs prompts on the connected phone from the home screen's "Describe the app" box and keeps each run's trace
# ({filesDir}/vera/trace.jsonl, with the "lookup" events tools/lookup-cache.js reads) and a screenshot.
#
#   tools/phone-run.sh PROMPTS.tsv OUTDIR [label ...]      # PROMPTS: family<TAB>label<TAB>prompt
#
# Needs: the phone unlocked and left alone, a vera-probe-dynamic build with traceLookup, hdc (through tool-paths.sh of
# VERA_PROBE, default ~/work/vera/vera-probe-distill). Each prompt makes a new app in the phone's list; no other app is touched.
# Taps are for a 1280x2832 screen; override FIELD / SEND for another.
set -u
PROMPTS=$1; OUT=$2; shift 2
source "${VERA_PROBE:-$HOME/work/vera/vera-probe-distill}/tool-paths.sh" >/dev/null || exit 1
export PATH=$(vera_hdc_dir | tail -1):$PATH
BUNDLE=com.vera.probe.dyn
TRACE=/data/app/el2/100/base/$BUNDLE/haps/entry/files/vera/trace.jsonl
FIELD=${FIELD:-"639 2272"}
SEND=${SEND:-"1126 2542"}
TIMEOUT=${TIMEOUT:-300}

on_screen() {  # true once the layout shows $1, false after $2 seconds
  local until=$(( $(date +%s) + ${2:-30} ))
  while (( $(date +%s) < until )); do
    hdc shell "uitest dumpLayout -p /data/local/tmp/pr-layout.json >/dev/null; grep -c '$1' /data/local/tmp/pr-layout.json" | grep -q '^[1-9]' && return 0
    sleep 1
  done
  return 1
}

# The agent may ask the person a question before it builds (VeraAgent.ets); on the host the suggested answer is taken
# (agent-run.js), so here the button marked "(suggested)" is tapped. True when one was.
answer_suggested() {
  hdc shell "uitest dumpLayout -p /data/local/tmp/pr-layout.json >/dev/null" >/dev/null
  hdc file recv /data/local/tmp/pr-layout.json /tmp/pr-layout.$$.json >/dev/null 2>&1 || return 1
  local at
  at=$(python3 - /tmp/pr-layout.$$.json <<'PY'
import json, re, sys
def walk(n):
    a = n.get('attributes', {})
    if '(suggested)' in a.get('text', '') and a.get('bounds'):
        x1, y1, x2, y2 = map(int, re.findall(r'-?\d+', a['bounds']))
        print((x1 + x2) // 2, (y1 + y2) // 2); sys.exit(0)
    for c in n.get('children', []): walk(c)
walk(json.load(open(sys.argv[1])))
PY
)
  [ -n "$at" ] || return 1
  hdc shell uitest uiInput click $at >/dev/null
}

grep -v '^#' "$PROMPTS" | while IFS=$'\t' read -r family label prompt; do
  [ -z "${label:-}" ] && continue
  if [ $# -gt 0 ] && [[ ! " $* " == *" $label "* ]]; then continue; fi
  dir=$OUT/$label
  [ -f "$dir/trace.jsonl" ] && grep -q '"event":"gen-end"' "$dir/trace.jsonl" && { echo "$label done before"; continue; }
  mkdir -p "$dir"
  hdc shell aa force-stop $BUNDLE >/dev/null
  hdc shell "rm -f $TRACE" >/dev/null
  hdc shell power-shell wakeup >/dev/null
  hdc shell aa start -a EntryAbility -b $BUNDLE >/dev/null
  if ! on_screen 'Describe the app' 30; then echo "$label: home screen not shown"; continue; fi
  hdc shell "uitest uiInput inputText $FIELD '$prompt'" >/dev/null
  sleep 1
  hdc shell uitest uiInput click $SEND >/dev/null
  start=$(date +%s); ended=0; answered=0
  while (( $(date +%s) - start < TIMEOUT )); do
    sleep 5
    hdc shell "grep -c gen-end $TRACE" 2>/dev/null | grep -q '^[1-9]' && { ended=1; break; }
    answer_suggested && answered=$((answered + 1))
  done
  sleep 2
  hdc file recv $TRACE "$dir/trace.jsonl" >/dev/null
  hdc shell snapshot_display -f /data/local/tmp/pr.jpeg >/dev/null; hdc file recv /data/local/tmp/pr.jpeg "$dir/screen.jpeg" >/dev/null
  printf '%-22s %s %3ss lookups=%s holes=%s answered=%s\n' "$label" "$([ $ended = 1 ] && echo ended || echo TIMEOUT)" "$(( $(date +%s) - start ))" \
    "$(grep -c '"event":"lookup"' "$dir/trace.jsonl")" "$(grep -c '"event":"hole"' "$dir/trace.jsonl")" "$answered"
done
