#!/usr/bin/env bash
# supathink 超限思考 卸载:摘除 hooks、协议块与 /slow /fast 命令;保留 ~/.supathink 数据(trace/quota 是脊柱,P6)
set -euo pipefail

TS="$(date +%Y%m%d-%H%M%S)"
BK="$HOME/.supathink/backup"
mkdir -p "$BK"
MARK_BEGIN="<!-- supathink:protocol:begin -->"
MARK_END="<!-- supathink:protocol:end -->"

remove_protocol_block() {
  local f="$1"
  local label="$2"
  local backup_name="$3"
  if [ -f "$f" ] && grep -qF "$MARK_BEGIN" "$f"; then
    if grep -qF "$MARK_END" "$f"; then
      cp "$f" "$BK/$backup_name.uninstall-$TS"
      node -e 'const fs=require("fs");const[f,b,e]=process.argv.slice(1);let s=fs.readFileSync(f,"utf8");const i=s.indexOf(b),j=s.indexOf(e);if(i>=0&&j>i){fs.writeFileSync(f,s.slice(0,i)+s.slice(j+e.length))}' "$f" "$MARK_BEGIN" "$MARK_END"
      echo "$label 协议块已摘除"
    else
      echo "警告:$label 只有 begin 标记、缺 end 标记,跳过自动摘除,请手工删除协议块"
    fi
  fi
}

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
remove_protocol_block "$CMD" "Claude" "CLAUDE.md"

for f in "$HOME/.claude/commands/st"/*.md "$HOME/.claude/commands"/{slow,fast}.md; do
  [ -f "$f" ] && grep -qE "SUPATHINK_(FORCE|SESSION)|supathink" "$f" && rm "$f" && echo "命令已移除:$f"
done
rmdir "$HOME/.claude/commands/st" 2>/dev/null || true
if [ -f "$HOME/.claude/skills/supathink/SKILL.md" ] && grep -q "supathink" "$HOME/.claude/skills/supathink/SKILL.md"; then
  rm -rf "$HOME/.claude/skills/supathink"
  echo "Claude supathink skill 已移除"
fi

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
remove_protocol_block "$AMD" "Codex" "AGENTS.md"
for f in "$CODEX_HOME_DIR/prompts"/st-*.md; do
  [ -f "$f" ] && grep -qE "SUPATHINK_(FORCE|SESSION|PANEL|ALTITUDE|WIN)|supathink|超限思考" "$f" && rm "$f"
done

# —— OpenClaw 侧摘除 ——
OC_AGENTS="$HOME/.openclaw/workspace/AGENTS.md"
remove_protocol_block "$OC_AGENTS" "OpenClaw" "openclaw-AGENTS.md"
if command -v openclaw >/dev/null 2>&1; then
  openclaw plugins uninstall supathink >/dev/null 2>&1 || openclaw plugins remove supathink >/dev/null 2>&1 || true
fi
if [ -d "$HOME/.supathink/openclaw-plugin" ]; then
  rm -rf "$HOME/.supathink/openclaw-plugin"
  echo "OpenClaw 插件 link 目录已移除"
fi
OC_CFG="$HOME/.openclaw/openclaw.json"
if [ -f "$OC_CFG" ]; then
  cp "$OC_CFG" "$BK/openclaw.json.uninstall-$TS"
  node - "$OC_CFG" <<'EOF'
const fs = require('fs');
const f = process.argv[2];
try {
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (s.plugins && s.plugins.entries && s.plugins.entries.supathink) {
    delete s.plugins.entries.supathink;
    const tmp = f + '.supathink-tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
    fs.renameSync(tmp, f);
    console.log('OpenClaw openclaw.json 插件配置已摘除');
  }
} catch (e) {
  console.log('警告:OpenClaw openclaw.json 未能自动清理(' + e.message + ')');
}
EOF
fi

# 停 daemon + 摘 CLI 软链
if [ -f "$HOME/.supathink/daemon.pid" ]; then
  kill "$(cat "$HOME/.supathink/daemon.pid")" 2>/dev/null && echo "daemon 已停" || true
  rm -f "$HOME/.supathink/daemon.pid"
fi
[ -L "$HOME/.local/bin/supathink" ] && rm "$HOME/.local/bin/supathink"
echo "卸载完成(~/.supathink 数据保留)"
