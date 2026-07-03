#!/usr/bin/env bash
# supathink 超限思考 卸载:摘除 hooks、协议块与 /slow /fast 命令;保留 ~/.supathink 数据(trace/quota 是脊柱,P6)
set -euo pipefail

TS="$(date +%Y%m%d-%H%M%S)"
BK="$HOME/.supathink/backup"
mkdir -p "$BK"

SETTINGS="$HOME/.claude/settings.json"
if [ -f "$SETTINGS" ]; then
  cp "$SETTINGS" "$BK/settings.json.uninstall-$TS" # 卸载前备份(评审 F6)
  node - "$SETTINGS" <<'EOF'
const fs = require('fs');
const f = process.argv[2];
const s = JSON.parse(fs.readFileSync(f, 'utf8'));
const isOurs = (h) => /\.(supathink|slowthink)/.test(h.command || '') || /127\.0\.0\.1:7777/.test(h.url || '');
for (const ev of Object.keys(s.hooks || {})) {
  s.hooks[ev] = s.hooks[ev]
    .map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => !isOurs(h)) }))
    .filter((m) => (m.hooks || []).length);
  if (!s.hooks[ev].length) delete s.hooks[ev];
}
const tmp = f + '.supathink-tmp'; // 原子写(评审 F6)
fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
fs.renameSync(tmp, f);
console.log('hooks 已摘除');
EOF
fi

CMD="$HOME/.claude/CLAUDE.md"
if [ -f "$CMD" ] && grep -qF "<!-- supathink:protocol:begin -->" "$CMD"; then
  if grep -qF "<!-- supathink:protocol:end -->" "$CMD"; then
    cp "$CMD" "$BK/CLAUDE.md.uninstall-$TS" # sed 区间删除前备份;end 标记缺失则拒删防误伤到文件尾(评审 F7)
    node -e 'const fs=require("fs");const[f,b,e]=process.argv.slice(1);let s=fs.readFileSync(f,"utf8");const i=s.indexOf(b),j=s.indexOf(e);if(i>=0&&j>i){fs.writeFileSync(f,s.slice(0,i)+s.slice(j+e.length))}' "$CMD" "<!-- supathink:protocol:begin -->" "<!-- supathink:protocol:end -->"
    echo "协议块已摘除"
  else
    echo "警告:CLAUDE.md 只有 begin 标记、缺 end 标记,跳过自动摘除,请手工删除协议块"
  fi
fi

for f in "$HOME/.claude/commands/st"/*.md "$HOME/.claude/commands"/{slow,fast}.md; do
  [ -f "$f" ] && grep -qE "SUPATHINK_(FORCE|SESSION)|supathink" "$f" && rm "$f" && echo "命令已移除:$f"
done
rmdir "$HOME/.claude/commands/st" 2>/dev/null || true

# —— Codex 侧摘除 ——
CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
CHOOKS="$CODEX_HOME_DIR/hooks.json"
if [ -f "$CHOOKS" ]; then
  cp "$CHOOKS" "$BK/codex-hooks.json.uninstall-$TS"
  node - "$CHOOKS" <<'EOF'
const fs = require('fs');
const f = process.argv[2];
const s = JSON.parse(fs.readFileSync(f, 'utf8'));
const isOurs = (h) => /supathink|127\.0\.0\.1:7777/.test(h.command || '');
for (const ev of Object.keys(s.hooks || {})) {
  s.hooks[ev] = s.hooks[ev].map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => !isOurs(h)) })).filter((m) => (m.hooks || []).length);
  if (!s.hooks[ev].length) delete s.hooks[ev];
}
const tmp = f + '.supathink-tmp';
fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
fs.renameSync(tmp, f);
console.log('Codex hooks 已摘除');
EOF
fi
AMD="$CODEX_HOME_DIR/AGENTS.md"
if [ -f "$AMD" ] && grep -qF "<!-- supathink:protocol:begin -->" "$AMD"; then
  if grep -qF "<!-- supathink:protocol:end -->" "$AMD"; then
    cp "$AMD" "$BK/AGENTS.md.uninstall-$TS"
    node -e 'const fs=require("fs");const[f,b,e]=process.argv.slice(1);let s=fs.readFileSync(f,"utf8");const i=s.indexOf(b),j=s.indexOf(e);if(i>=0&&j>i){fs.writeFileSync(f,s.slice(0,i)+s.slice(j+e.length))}' "$AMD" "<!-- supathink:protocol:begin -->" "<!-- supathink:protocol:end -->"
    echo "Codex 协议块已摘除"
  else
    echo "警告:AGENTS.md 缺 end 标记,跳过自动摘除"
  fi
fi
for f in "$CODEX_HOME_DIR/prompts"/st-*.md; do
  [ -f "$f" ] && grep -qE "SUPATHINK_(FORCE|SESSION|PANEL|ALTITUDE)" "$f" && rm "$f"
done

# 停 daemon + 摘 CLI 软链
if [ -f "$HOME/.supathink/daemon.pid" ]; then
  kill "$(cat "$HOME/.supathink/daemon.pid")" 2>/dev/null && echo "daemon 已停" || true
  rm -f "$HOME/.supathink/daemon.pid"
fi
[ -L "$HOME/.local/bin/supathink" ] && rm "$HOME/.local/bin/supathink"
echo "卸载完成(~/.supathink 数据保留)"
