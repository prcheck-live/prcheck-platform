#!/usr/bin/env bash
# Stops the tunnel, engine, runner and QE app started by start.sh / qe-deploy.sh.
QH=${QIVVRA_HOME:-$HOME/qivvra}
for p in tunnel engine runner; do
  f="$QH/logs/$p.pid"; [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null && echo "stopped  $p"; rm -f "$f"
done
[ -f "$QH/qe/qe.pid" ] && kill "$(cat "$QH/qe/qe.pid")" 2>/dev/null && echo "stopped  QE"; rm -f "$QH/qe/qe.pid"
echo "The GitHub webhook now points at a dead tunnel; start.sh updates it next time."
