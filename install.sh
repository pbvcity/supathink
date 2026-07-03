#!/usr/bin/env bash
# supathink 超限思考 安装:文件落位 ~/.supathink + 用户级 hooks 接线 + 协议块入 ~/.claude/CLAUDE.md + /slow /fast 命令
# 幂等;凡有覆写先备份到 ~/.supathink/backup/;env 只在缺失时创建(不覆盖用户填好的真实 key)
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HOME/.supathink"
TS="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$ROOT"/{bin,lib,daemon,protocol,sessions,claims-cache,traces-archive,backup,critic-work}
cp "$SRC"/src/bin/st-hook-user-prompt.js "$SRC"/src/bin/st-hook-stop.js "$ROOT/bin/"   # Phase 0 命令 hook 保留作降级/回退件
cp "$SRC"/src/bin/ensure-daemon.sh "$SRC"/src/bin/supathink "$SRC"/src/bin/st-statusline.js "$SRC"/src/bin/pb-review.js "$ROOT/bin/"
cp "$SRC"/src/lib/router.js "$SRC"/src/lib/menu.js "$SRC"/src/lib/trace.js "$SRC"/src/lib/critic.js "$SRC"/src/lib/config.js "$ROOT/lib/"
cp "$SRC"/src/daemon/*.js "$ROOT/daemon/"
cp "$SRC"/src/protocol/proposer-protocol.md "$SRC"/src/protocol/proposer-protocol-openclaw.md "$ROOT/protocol/"
chmod +x "$ROOT"/bin/* 2>/dev/null || true
mkdir -p "$HOME/.local/bin" && ln -sf "$ROOT/bin/supathink" "$HOME/.local/bin/supathink"

# —— 资源底座 env(仅缺失时从 env.example 创建;不覆盖用户已填的真实 key)——
if [ ! -f "$ROOT/env" ]; then
  cp "$SRC/env.example" "$ROOT/env"
  echo "env 已创建(假数据占位,请替换 key):$ROOT/env"
else
  echo "env 已存在,保留:$ROOT/env"
fi

# —— hooks 合并进 ~/.claude/settings.json ——
SETTINGS="$HOME/.claude/settings.json"
[ -f "$SETTINGS" ] && cp "$SETTINGS" "$ROOT/backup/settings.json.$TS"
node - "$SETTINGS" <<'EOF'
const fs = require('fs');
const f = process.argv[2];
const s = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
s.hooks = s.hooks || {};
// Phase 1(§9.2):HTTP hooks + ensure-daemon 自拉起;先清本系统旧接线(含 Phase 0 命令 hook 与 .slowthink 残留)
const isOurs = (h) => /\.(supathink|slowthink)/.test(h.command || '') || /127\.0\.0\.1:7777/.test(h.url || '');
for (const ev of Object.keys(s.hooks)) {
  s.hooks[ev] = s.hooks[ev].map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => !isOurs(h)) })).filter((m) => (m.hooks || []).length);
  if (!s.hooks[ev].length) delete s.hooks[ev];
}
const ensureSh = { type: 'command', command: 'bash "$HOME/.supathink/bin/ensure-daemon.sh"', timeout: 10 };
const httpH = (route, timeout) => ({ type: 'http', url: `http://127.0.0.1:7777/v1/hook/${route}`, timeout });
const add = (ev, hooks) => { (s.hooks[ev] = s.hooks[ev] || []).push({ hooks }); };
add('SessionStart', [ensureSh, httpH('session-start', 10)]);
add('UserPromptSubmit', [ensureSh, httpH('user-prompt', 10)]); // ensure 在前:daemon 崩溃下一轮即自拉起(DoD①)
add('Stop', [httpH('stop', 90)]);
add('PreCompact', [httpH('pre-compact', 15)]);
const tmp = f + '.supathink-tmp'; // 原子写:settings.json 是宿主全局配置,截断即损坏(评审 F6)
fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
fs.renameSync(tmp, f);
console.log('HTTP hooks 已写入 ' + f);
EOF

# —— 协议块(附录 A)入用户级 CLAUDE.md,带标记幂等 ——
CMD="$HOME/.claude/CLAUDE.md"
MARK_BEGIN="<!-- supathink:protocol:begin -->"
MARK_END="<!-- supathink:protocol:end -->"
[ -f "$CMD" ] && cp "$CMD" "$ROOT/backup/CLAUDE.md.$TS"
if [ -f "$CMD" ] && grep -qF "$MARK_BEGIN" "$CMD" && grep -qF "$MARK_END" "$CMD"; then
  node -e 'const fs=require("fs");const[f,b,e]=process.argv.slice(1);let s=fs.readFileSync(f,"utf8");const i=s.indexOf(b),j=s.indexOf(e);if(i>=0&&j>i){fs.writeFileSync(f,s.slice(0,i)+s.slice(j+e.length))}' "$CMD" "$MARK_BEGIN" "$MARK_END"
fi
{ [ -f "$CMD" ] && cat "$CMD"; echo; echo "$MARK_BEGIN"; cat "$ROOT/protocol/proposer-protocol.md"; echo "$MARK_END"; } > "$CMD.tmp"
mv "$CMD.tmp" "$CMD"
echo "协议块已写入(刷新)$CMD"

# —— /st:* 用户命令(命名空间目录,避免与其他插件冲突)——
CMDS="$HOME/.claude/commands"
mkdir -p "$CMDS/st"
for c in slow fast; do # 迁移:摘除旧的顶级 /slow /fast(仅当是本系统的)
  [ -f "$CMDS/$c.md" ] && grep -qF "SUPATHINK_FORCE" "$CMDS/$c.md" && rm "$CMDS/$c.md"
done
cat > "$CMDS/st/slow.md" <<'EOF'
---
description: supathink 超限思考:本轮强制 full 档(菜单注入 + Critic 快审 + 修订循环)
---
SUPATHINK_FORCE=full

$ARGUMENTS
EOF
cat > "$CMDS/st/fast.md" <<'EOF'
---
description: supathink 超限思考:本轮强制跳过一切校验
---
SUPATHINK_FORCE=off

$ARGUMENTS
EOF
cat > "$CMDS/st/on.md" <<'EOF'
---
description: supathink 超限思考:本会话开启自动分档(off/light/full 按需)
---
SUPATHINK_SESSION=on

$ARGUMENTS
EOF
cat > "$CMDS/st/off.md" <<'EOF'
---
description: supathink 超限思考:本会话关闭自动分档
---
SUPATHINK_SESSION=off

$ARGUMENTS
EOF
cat > "$CMDS/st/init.md" <<'EOF'
---
description: supathink 超限思考:引导式初始化用户级/项目级配置
---
用户想初始化 supathink 超限思考配置。请逐步引导(用 AskUserQuestion 或对话均可):
1. 作用范围:用户级(~/.supathink/env,所有项目生效)还是项目级(当前项目根 .supathink.json,仅本项目)?
2. 自动分档 auto:true = Router 按需 off/light/full;false = 仅 /st:slow、/st:on 唤起。
3. 快审后端:留空 = 自动(有可用 DeepSeek key 用 deepseek,否则宿主 haiku);或显式 haiku / deepseek。
4. 若选 deepseek 且 ~/.supathink/env 里还是假 key:让用户自己在终端执行下面命令填 key(不要让用户把 key 贴进对话):
   read -rs -p "DeepSeek API Key: " K && printf "\nSUPATHINK_DEEPSEEK_API_KEY=%s\n" "$K" >> ~/.supathink/env && unset K && echo 已写入(后行覆盖先行,追加即生效)
5. 按选择写入:项目级 → 项目根 .supathink.json(如 {"auto":true} 或加 "critic_backend");用户级 → 修改 ~/.supathink/env 对应行。
6. 最后跑 supathink status 展示生效配置,并提醒:总开关 supathink on|off;本轮强制 /st:slow;卸载 uninstall.sh。

$ARGUMENTS
EOF
cat > "$CMDS/st/panel.md" <<'EOF'
---
description: supathink 超限思考:异构多模型 panel(席位并行 + Judge 综合,结果下一轮注入)
---
SUPATHINK_PANEL=panel

$ARGUMENTS
EOF
cat > "$CMDS/st/panel-lite.md" <<'EOF'
---
description: supathink 超限思考:panel-lite(单强模型三视角自综合,1× 成本,低风险发散用)
---
SUPATHINK_PANEL=lite

$ARGUMENTS
EOF
cat > "$CMDS/st/altitude.md" <<'EOF'
---
description: supathink 超限思考:Navigator 手动抬头(目标回溯/代理警报七轴,结果下一轮注入)
---
SUPATHINK_ALTITUDE=1

$ARGUMENTS
EOF
for c in debate delphi redblue slow-full; do
  MARKER="SUPATHINK_PANEL=$c"
  DESC="supathink 超限思考"
  case "$c" in
    debate) DESC="$DESC:正反论辩两轮 + Judge 裁决(高争议命题,结果下轮注入)";;
    delphi) DESC="$DESC:各席独立估计→匿名汇总→再修正(预测/估值,禁互看初稿)";;
    redblue) DESC="$DESC:蓝出方案红攻蓝补(鲁棒性压测,结果下轮注入)";;
    slow-full) MARKER="SUPATHINK_FORCE=full-ledger"; DESC="$DESC:full 档 + 你先自出 claim 账本再作答";;
  esac
  printf -- "---\ndescription: %s\n---\n%s\n\n\$ARGUMENTS\n" "$DESC" "$MARKER" > "$CMDS/st/$c.md"
done
echo "命令已安装:/st:slow /st:slow-full /st:fast /st:on /st:off /st:init /st:panel /st:panel-lite /st:debate /st:delphi /st:redblue /st:altitude"

# —— CC 自判 skill(协议第 6 条的模型侧入口:判断权在模型)——
mkdir -p "$HOME/.claude/skills/supathink"
cat > "$HOME/.claude/skills/supathink/SKILL.md" <<'EOF'
---
name: supathink
description: 超限思考自判升档——当你判断本轮值得深度校验(事实密集/引用支撑关键结论/决策关口/不可逆动作/用户质疑正确性)或值得异构多脑合议时使用;判断权在你,不靠关键词。
---
按超限思考协议第 6 条执行:
1. 深度校验:用 Bash 运行 `supathink escalate full --methods "<你选的思考方法>"`(轻校验用 light),然后正常作答——交付前系统会核验你的草稿并可能打回修订。
2. 多脑合议:用 Bash 运行 `supathink panel "<议题>"`(低成本三视角用 `supathink panel-lite`),先给出你自己的独立分析,异构综合结果将于下一轮注入。
3. 红线:已升档轮次的核验与授权之门,不因你的判断而豁免。
EOF
echo "自判 skill 已安装:~/.claude/skills/supathink"

# —— Codex 宿主接线(Phase 3;双宿主原则)——
if command -v codex >/dev/null 2>&1; then
  CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
  mkdir -p "$CODEX_HOME_DIR"
  CHOOKS="$CODEX_HOME_DIR/hooks.json"
  [ -f "$CHOOKS" ] && cp "$CHOOKS" "$ROOT/backup/codex-hooks.json.$TS"
  node - "$CHOOKS" <<'EOF'
const fs = require('fs');
const f = process.argv[2];
const s = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
s.hooks = s.hooks || {};
const isOurs = (h) => /supathink|127\.0\.0\.1:7777/.test(h.command || '');
for (const ev of Object.keys(s.hooks)) {
  s.hooks[ev] = s.hooks[ev].map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => !isOurs(h)) })).filter((m) => (m.hooks || []).length);
  if (!s.hooks[ev].length) delete s.hooks[ev];
}
const ensureSh = { type: 'command', command: 'bash "$HOME/.supathink/bin/ensure-daemon.sh"', timeout: 10 };
const shim = (route, m, timeout) => ({ type: 'command', command: `curl -sS -m ${m} -X POST -H 'Content-Type: application/json' -d @- http://127.0.0.1:7777/v1/hook/${route} || echo '{}'`, timeout }); // §9.2 curl shim:超时/失败=放行
const add = (ev, hooks) => { (s.hooks[ev] = s.hooks[ev] || []).push({ hooks }); };
add('SessionStart', [ensureSh, shim('session-start', 8, 15)]);
add('UserPromptSubmit', [ensureSh, shim('user-prompt', 8, 15)]);
add('Stop', [shim('stop', 90, 120)]);
add('PreCompact', [shim('pre-compact', 10, 15)]);
const tmp = f + '.supathink-tmp';
fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
fs.renameSync(tmp, f);
console.log('Codex hooks 已写入 ' + f + '(需一次性授信:codex 交互界面里执行 /hooks 批准 supathink 条目)');
EOF

  # 协议块入 ~/.codex/AGENTS.md(与 CLAUDE.md 单源同标记)
  AMD="$CODEX_HOME_DIR/AGENTS.md"
  [ -f "$AMD" ] && cp "$AMD" "$ROOT/backup/AGENTS.md.$TS"
  if [ -f "$AMD" ] && grep -qF "$MARK_BEGIN" "$AMD" && grep -qF "$MARK_END" "$AMD"; then
    node -e 'const fs=require("fs");const[f,b,e]=process.argv.slice(1);let s=fs.readFileSync(f,"utf8");const i=s.indexOf(b),j=s.indexOf(e);if(i>=0&&j>i){fs.writeFileSync(f,s.slice(0,i)+s.slice(j+e.length))}' "$AMD" "$MARK_BEGIN" "$MARK_END"
  fi
  { [ -f "$AMD" ] && cat "$AMD"; echo; echo "$MARK_BEGIN"; cat "$ROOT/protocol/proposer-protocol.md"; echo "$MARK_END"; } > "$AMD.tmp"
  mv "$AMD.tmp" "$AMD"
  echo "协议块已写入(刷新)$AMD"

  # Codex 自定义 prompts(命令糖;原始前缀/标记始终有效,此层仅便捷)
  mkdir -p "$CODEX_HOME_DIR/prompts"
  for c in slow slow-full fast on off panel panel-lite debate delphi redblue altitude; do
    MARKER="SUPATHINK_FORCE=full"
    case "$c" in
      fast) MARKER="SUPATHINK_FORCE=off";;
      on) MARKER="SUPATHINK_SESSION=on";;
      off) MARKER="SUPATHINK_SESSION=off";;
      panel) MARKER="SUPATHINK_PANEL=panel";;
      panel-lite) MARKER="SUPATHINK_PANEL=lite";;
      altitude) MARKER="SUPATHINK_ALTITUDE=1";;
      slow-full) MARKER="SUPATHINK_FORCE=full-ledger";;
      debate) MARKER="SUPATHINK_PANEL=debate";;
      delphi) MARKER="SUPATHINK_PANEL=delphi";;
      redblue) MARKER="SUPATHINK_PANEL=redblue";;
    esac
    printf '%s\n\n$ARGUMENTS\n' "$MARKER" > "$CODEX_HOME_DIR/prompts/st-$c.md"
  done
  echo "Codex prompts 已安装:/st-slow /st-fast /st-on /st-off /st-panel /st-panel-lite /st-altitude"
else
  echo "未检测到 codex,跳过 Codex 接线"
fi

# —— OpenClaw 宿主接线(Phase 4,第三宿主;supathink 装在 OpenClaw 所在环境:容器就在容器里跑本脚本)——
OC_WS="$HOME/.openclaw/workspace"
if [ -d "$OC_WS" ]; then
  OCA="$OC_WS/AGENTS.md"
  [ -f "$OCA" ] && cp "$OCA" "$ROOT/backup/openclaw-AGENTS.md.$TS"
  if [ -f "$OCA" ] && grep -qF "$MARK_BEGIN" "$OCA" && grep -qF "$MARK_END" "$OCA"; then
    node -e 'const fs=require("fs");const[f,b,e]=process.argv.slice(1);let s=fs.readFileSync(f,"utf8");const i=s.indexOf(b),j=s.indexOf(e);if(i>=0&&j>i){fs.writeFileSync(f,s.slice(0,i)+s.slice(j+e.length))}' "$OCA" "$MARK_BEGIN" "$MARK_END" # 刷新:摘旧块再写新块
  fi
  { [ -f "$OCA" ] && cat "$OCA"; echo; echo "$MARK_BEGIN"; cat "$ROOT/protocol/proposer-protocol-openclaw.md"; echo "$MARK_END"; } > "$OCA.tmp"
  mv "$OCA.tmp" "$OCA"
  echo "OpenClaw 协议块已写入 $OCA(agent 交付前将调 /v1/review 自查,策略集中在 daemon)"
  # agent 级策略文件(仅缺失时生成:发现的 agents 全部默认关,用户自行放开;P1 默认关)
  if [ ! -f "$ROOT/openclaw.json" ] && [ -d "$HOME/.openclaw/agents" ]; then
    node - "$HOME/.openclaw/agents" "$ROOT/openclaw.json" <<'EOF'
const fs = require('fs');
const agents = {};
try { for (const a of fs.readdirSync(process.argv[2])) agents[a] = { auto: false }; } catch (_) {}
fs.writeFileSync(process.argv[3], JSON.stringify({ _注释: 'OpenClaw agent 级策略:auto=true 的 agent 按需分档;false 只响应 /st:slow 与高危自查', default: 'off', agents }, null, 2) + '\n');
console.log('agent 策略文件已生成(全部默认关):' + process.argv[3]);
EOF
  fi
  # v2 原生插件(硬拦截):before_agent_finalize → /v1/review → revise 重写;协议层降级为插件失效时的兜底
  if command -v openclaw >/dev/null 2>&1 && [ -d "$SRC/hosts/openclaw" ]; then
    mkdir -p "$ROOT/openclaw-plugin"
    cp "$SRC"/hosts/openclaw/openclaw.plugin.json "$SRC"/hosts/openclaw/package.json "$SRC"/hosts/openclaw/index.js "$ROOT/openclaw-plugin/"
    # 会话钩子门禁:allowConversationAccess(非 bundled 插件用 before_agent_finalize 必需)
    node - "$HOME/.openclaw/openclaw.json" <<'EOF'
const fs = require('fs');
const f = process.argv[2];
try {
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  s.plugins = s.plugins || {};
  s.plugins.entries = s.plugins.entries || {};
  s.plugins.entries.supathink = s.plugins.entries.supathink || {};
  s.plugins.entries.supathink.hooks = { ...(s.plugins.entries.supathink.hooks || {}), allowConversationAccess: true };
  const tmp = f + '.supathink-tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  fs.renameSync(tmp, f);
  console.log('openclaw.json:allowConversationAccess 已置位');
} catch (e) { console.log('openclaw.json 未能修改(' + e.message + '),请手动加 plugins.entries.supathink.hooks.allowConversationAccess=true'); }
EOF
    openclaw plugins install --link "$ROOT/openclaw-plugin" 2>&1 | tail -2 || echo "插件 link 安装失败,协议层仍生效(降级)"
  fi
  bash "$ROOT/bin/ensure-daemon.sh" || true
else
  echo "未检测到 OpenClaw workspace,跳过 OpenClaw 接线"
fi

# —— 升级生效:重启在跑的 daemon(healthz 返回的真实 pid 比 pid 文件可靠;decisions #13)——
PORT="${SUPATHINK_PORT:-7777}"
LIVE="$(curl -sf -m 1 "http://127.0.0.1:$PORT/healthz" 2>/dev/null | grep -o '"pid":[0-9]*' | cut -d: -f2 || true)"
if [ -n "${LIVE:-}" ]; then
  kill "$LIVE" 2>/dev/null || true
  sleep 0.5
  bash "$ROOT/bin/ensure-daemon.sh" || true
  echo "daemon 已重启加载新代码(旧 pid $LIVE)"
fi

echo "安装完成。默认关(SUPATHINK_AUTO=false);项目级开启:项目根放 .supathink.json {\"auto\":true};总开关:touch ~/.supathink/DISABLED;卸载:./uninstall.sh"
