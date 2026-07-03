#!/usr/bin/env node
'use strict';
// UserPromptSubmit command hook(Phase 0.5):激活链判定 → 纯规则门控 + 菜单注入 + 教练门检测
// 激活链:/slow /fast 命令必开必关 > 项目 .supathink.json {"auto":true|false} > ~/.supathink/env SUPATHINK_AUTO > 默认关
// auto=true 也不是全开:Router 仍按需分档 off/light/full
// 输入(stdin,实测 2.1.177):{session_id, transcript_path, cwd, permission_mode, hook_event_name, prompt}
// 铁律(§3.4):任何故障都输出 {} 并 exit 0,绝不阻塞宿主

const path = require('path');
const fs = require('fs');
const os = require('os');

function emit(obj) { process.stdout.write(JSON.stringify(obj)); process.exit(0); }

if (process.env.SUPATHINK_CRITIC === '1') emit({}); // 防递归:Critic 子进程自身的 hooks 直接放行
try { // 总开关:touch ~/.supathink/DISABLED 即全体静默停用(§3.4 可用性)
  if (fs.existsSync(path.join(os.homedir(), '.supathink', 'DISABLED'))) emit({});
} catch (_) { /* 检查失败视同启用 */ }

let payload;
try {
  payload = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch (_) { emit({}); }

try {
  const { route } = require(path.join(__dirname, '..', 'lib', 'router'));
  const { renderMenu } = require(path.join(__dirname, '..', 'lib', 'menu'));
  const { appendTrace, loadState, saveState, sessionStateExists } = require(path.join(__dirname, '..', 'lib', 'trace'));
  const { loadConfig, detectForce } = require(path.join(__dirname, '..', 'lib', 'config'));

  const sessionId = payload.session_id || 'unknown';
  const cfg = loadConfig(payload.cwd);
  const force = detectForce(payload.prompt);

  // 未激活且无命令:零足迹放行;但若本会话有历史状态,推进 turn 并标记 inactive,
  // 防止上一轮残留误触 Stop 侧 Critic 或追加错位 trace(评审 F11)
  if (!cfg.auto && !force) {
    if (sessionStateExists(sessionId)) {
      const st = loadState(sessionId);
      st.turn = (st.turn || 0) + 1;
      st.last_mode = 'off';
      st.inactive = true;
      saveState(sessionId, st);
    }
    emit({});
  }

  const decision = route(payload.prompt);
  if (force === 'off') { decision.mode = 'off'; decision.triggers = [...decision.triggers, 'user_fast']; }
  if (force === 'full') { decision.mode = 'full'; decision.triggers = [...decision.triggers, 'user_slow']; if (!decision.intent) decision.intent = 'decide'; if (!decision.menu) decision.menu = require(path.join(__dirname, '..', 'lib', 'menu')).pickMenu(decision.intent); }

  const state = loadState(sessionId);
  state.turn = (state.turn || 0) + 1;
  state.inactive = false;
  state.last_mode = decision.mode;
  state.last_intent = decision.intent;
  state.last_triggers = decision.triggers;
  state.critic_loops = 0; // 新一轮,复位 Stop 侧修订循环计数(上限 2,§3.2)
  state.cwd = payload.cwd;
  saveState(sessionId, state);

  appendTrace(sessionId, {
    turn: state.turn,
    type: 'route_decision',
    mode: decision.mode,
    stance_hint: decision.stance_hint,
    triggers: decision.triggers,
    menu: decision.menu || [],
  });

  if (decision.mode === 'off') emit({}); // P1:off 轮零注入零打扰

  const parts = [];
  if (decision.menu) parts.push(renderMenu(decision.menu));
  if (decision.stance_hint === 'coach_gate_check') {
    parts.push('[超限思考] 检测到交权信号:按超限思考协议第 4 条执行主导权门——先区分「大事压顶想要脚手架」与「真实危机」;危机则不接管、关怀并引向真实的人;非危机则显式确认授权范围后再有界主导。');
  }
  if (!parts.length) emit({});

  emit({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: parts.join('\n\n'),
    },
    suppressOutput: true,
  });
} catch (_) { emit({}); }
