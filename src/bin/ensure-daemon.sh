#!/usr/bin/env bash
# spawn-if-not-running(§9.1):healthz 活着就秒退;mkdir 原子锁防并发拉起(跨平台:macOS 无 flock)
# SessionStart 与 UserPromptSubmit 都挂,崩溃自拉起(DoD①)
set -u
ROOT="$HOME/.supathink"
PORT="${SUPATHINK_PORT:-7777}"
[ -f "$ROOT/DISABLED" ] && exit 0
curl -sf -m 1 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && exit 0

LOCKDIR="$ROOT/daemon.lock.d"
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  # 陈旧锁(>60s,拉起进程曾崩在半路)清除后重试一次;仍拿不到 = 别人正在拉起
  MT=$(stat -c %Y "$LOCKDIR" 2>/dev/null || stat -f %m "$LOCKDIR" 2>/dev/null || echo 0)
  AGE=$(( $(date +%s) - MT ))
  if [ "$AGE" -gt 60 ]; then rmdir "$LOCKDIR" 2>/dev/null; fi
  mkdir "$LOCKDIR" 2>/dev/null || exit 0
fi
trap 'rmdir "$LOCKDIR" 2>/dev/null' EXIT

curl -sf -m 1 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && exit 0
nohup node "$ROOT/daemon/server.js" >>"$ROOT/daemon.log" 2>&1 &
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 0.1
  curl -sf -m 1 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && exit 0
done
exit 0  # 拉不起来也不阻塞宿主(§3.4)
