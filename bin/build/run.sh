#!/usr/bin/env bash
# Survivor wrapper for bin/build.ts: run the orchestrator, then record how the bun
# process exited to build.log — the only way to attribute an uncatchable SIGKILL
# (137), segfault (139), or externally-delivered signal. A bash shell is a robust
# survivor: it can't itself segfault from a Bun bug. See
# build/orchestrator-crash-diagnostic.
#
# NOTE: `set -e` is deliberately NOT used — we must reach the log line even when
# bun exits non-zero. Process substitution requires bash (invoke via `bash`).
set -u
feature="${1:?usage: run.sh <feature>}"
log="build/${feature}/build.log"
mkdir -p "build/${feature}"
# Survive a GROUP-wide signal (the observed kill sweeps deliver SIGTERM to the
# whole process group, wrapper included — which previously killed this shell
# before it could write the exit line, leaving "no wrapper exit line found"
# autopsies). With a trap set, bash defers the signal until the foreground bun
# finishes exiting, then continues — so both log lines below still land. The
# recorded signal also distinguishes a group-wide sweep (wrapper signalled too)
# from a targeted kill of bun alone. SIGKILL remains untrappable by design.
# Trade-off: a TERM aimed at the wrapper alone no longer kills it — it keeps
# waiting for bun (kill bun's pid, or SIGKILL the wrapper, to stop the run).
wrapper_sig=""
trap 'wrapper_sig=SIGTERM' TERM
trap 'wrapper_sig=SIGINT' INT
trap 'wrapper_sig=SIGHUP' HUP
# Tee bun's OWN stderr into build.log (H3: capture a panic/segfault message tail)
# while still surfacing it on the inherited stderr. bun's child-process output
# already lands in build.log via harness/validate; this covers bin/build.ts's own
# stderr.
bun run bin/build.ts "$feature" 2> >(tee -a "$log" >&2)
code=$?
# $? is 128+signum on signal death. Derive a human signal label for the common
# codes so build.log is self-explaining without knowing Unix conventions.
case "$code" in
  129) sig=", signal=SIGHUP" ;;
  130) sig=", signal=SIGINT" ;;
  137) sig=", signal=SIGKILL" ;;
  139) sig=", signal=SIGSEGV" ;;
  143) sig=", signal=SIGTERM" ;;
  *)   sig="" ;;
esac
ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '[%s] wrapper: bun process exited (code=%s%s)\n' "$ts" "$code" "$sig" >> "$log"
if [ -n "$wrapper_sig" ]; then
  printf '[%s] wrapper: wrapper itself received %s — signal was delivered group-wide (an external sweep of the whole process tree, not a targeted kill of bun)\n' "$ts" "$wrapper_sig" >> "$log"
fi
exit "$code"
