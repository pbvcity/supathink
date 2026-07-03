#!/usr/bin/env node
'use strict';
// Stop command hook(Phase 0.5):毫秒级门控 → 仅 light/full 轮起快审 Critic(后端见 ~/.supathink/env)
// 输入(stdin,实测 2.1.177):{session_id, transcript_path, stop_hook_active, last_assistant_message, ...}
// 输出:放行 {} ;有 blocker/major:{"decision":"block","reason":"副驾批注:..."}(§3.2)
// 铁律(§3.4):任何故障放行,绝不阻塞宿主。循环上限 2(§3.2)。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

function emit(obj) { process.stdout.write(JSON.stringify(obj)); process.exit(0); }

if (process.env.SUPATHINK_CRITIC === '1') emit({}); // 防递归:Critic 子进程自身的 Stop 直接放行
try { // 总开关:touch ~/.supathink/DISABLED 即全体静默停用(§3.4 可用性)
  if (fs.existsSync(path.join(os.homedir(), '.supathink', 'DISABLED'))) emit({});
} catch (_) { /* 检查失败视同启用 */ }

let payload;
try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { emit({}); }

const t0 = Date.now();
(async () => {
  const { appendTrace, loadState, saveState, sessionStateExists } = require(path.join(__dirname, '..', 'lib', 'trace'));
  const { runCritic } = require(path.join(__dirname, '..', 'lib', 'critic'));
  const { loadConfig } = require(path.join(__dirname, '..', 'lib', 'config'));

  const sessionId = payload.session_id || 'unknown';
  if (!sessionStateExists(sessionId)) emit({}); // 本会话从未激活:零足迹放行

  const state = loadState(sessionId);
  if (state.inactive) emit({}); // 未激活轮(评审 F11):不追加 final_delivered,防 turn 错位
  const mode = state.last_mode || 'off';
  const turn = state.turn || 0;

  const allow = (extra) => {
    appendTrace(sessionId, {
      turn, type: 'final_delivered', mode,
      loops: state.critic_loops || 0,
      footer: (state.critic_loops || 0) > 0 ? 'proposer-inline' : null,
      added_latency_ms: Date.now() - t0,
      ...extra,
    });
    emit({});
  };

  if (mode === 'off') allow({}); // P1:off 轮零延迟路径

  const loops = state.critic_loops || 0;
  if (payload.stop_hook_active && loops >= 2) allow({ critic_status: 'loop_cap_reached' }); // 上限 2,防死循环

  // 取 draft:2.1.177 payload 直给 last_assistant_message;缺失则回退解析 transcript
  let draft = payload.last_assistant_message || '';
  if (!draft && payload.transcript_path) {
    try {
      const lines = fs.readFileSync(payload.transcript_path, 'utf8').trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const ev = JSON.parse(lines[i]);
          if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
            draft = ev.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
            if (draft) break;
          }
        } catch (_) { /* 跳过坏行 */ }
      }
    } catch (_) { /* 读不到 transcript → 无 draft */ }
  }
  if (!draft) allow({ critic_status: 'no_draft' });

  appendTrace(sessionId, {
    turn, type: 'draft_captured',
    chars: draft.length,
    hash: crypto.createHash('sha256').update(draft).digest('hex').slice(0, 16),
  });

  const cfg = loadConfig(state.cwd || payload.cwd);
  const result = await runCritic(draft, cfg);
  if (!result) allow({ critic_status: 'critic_failed', backend: cfg.backend }); // 优雅降级(含 DeepSeek 无 key/网络失败)

  // quota 记录(DoD④/OPEN-6)
  try {
    fs.appendFileSync(path.join(os.homedir(), '.supathink', 'quota.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), session_id: sessionId, turn, event: 'critic_run', ...result.usage }) + '\n');
  } catch (_) { /* 不阻塞 */ }

  const review = result.review;
  appendTrace(sessionId, { turn, type: 'claims_extracted', claims: review.claims || [] });
  const CANON = ['supported', 'refuted', 'not_found', 'skipped']; // §9.4 verdict 枚举
  for (const c of review.claims || []) {
    if (!c.verdict) continue;
    if (c.type !== 'fact' && c.type !== 'citation') continue; // 推理/假设类问题走 annotations,不发 verification_result
    const verdict = CANON.includes(c.verdict) ? c.verdict : 'not_found';
    appendTrace(sessionId, {
      turn, type: 'verification_result',
      claim_id: c.id, verdict,
      raw_verdict: verdict === c.verdict ? undefined : c.verdict,
      source: c.source || null, latency_ms: null, cache_hit: false,
    });
  }

  // 严重度门控(§3.2):light 命中 blocker → 就地升级 full(修订循环按 full 门槛,同批 major 一并批注);full 拦 blocker/major
  let severe = (review.annotations || []).filter((a) => a.severity === 'blocker' || a.severity === 'major');
  if (mode === 'light') {
    if (severe.some((a) => a.severity === 'blocker')) {
      state.last_mode = 'full'; // 就地升级(§3.2,评审 F10)
    } else {
      severe = [];
    }
  }
  if (severe.length) {
    state.critic_loops = loops + 1;
    const persisted = saveState(sessionId, state);
    if (!persisted && payload.stop_hook_active) {
      // 循环计数器写不进磁盘时绝不二次 block:铁律「不阻塞宿主」优先于上限 2(评审 F4,critical)
      allow({ critic_status: 'state_unwritable_loop_guard' });
    }
    const lines = severe.map((a, i) => `${i + 1}. [${a.severity}] ${a.issue}`);
    emit({
      decision: 'block',
      reason: `副驾批注:\n${lines.join('\n')}\n请按超限思考协议第 3 条逐条回应:采纳(修改)/ 驳回(给出具体理由)/ 待查;修订后在答案末尾保留「── 核验 ──」脚注(✓ 已证实 / ✗ 已修正 / △ 未决 + 置信)。`,
    });
  }

  allow({ critic_status: 'pass', annotations: (review.annotations || []).length });
})().catch(() => emit({}));
