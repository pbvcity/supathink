#!/usr/bin/env node
'use strict';
// Phase 2 DoD:②对抗样例下循环上限强制生效不死循环 ④judge=席位 的错误配置被校验拒绝
// 另:panel-lite 全链(deepseek 单后端即可跑)、panel 缺席报告、/st:altitude 强制 Navigator
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 7798;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(os.homedir(), '.supathink');
const E2E = '/tmp/supathink-dod-proj';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (route, body) => {
  const res = await fetch(`${BASE}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
};
const readTrace = (sid) => fs.readFileSync(path.join(ROOT, 'sessions', sid, 'trace.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
let fails = 0;
const assert = (ok, name, detail) => { console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) fails++; };

(async () => {
  fs.mkdirSync(E2E, { recursive: true });
  fs.writeFileSync(path.join(E2E, '.supathink.json'), '{"auto":true}');

  // ── DoD④:judge=席位 → 校验拒绝(单元 + panel 入口)──
  const capsLib = require(path.join(__dirname, '..', 'src', 'daemon', 'capabilities'));
  const { resolveEngine } = require(path.join(__dirname, '..', 'src', 'daemon', 'engines'));
  const { loadConfig } = require(path.join(__dirname, '..', 'src', 'lib', 'config'));
  const cfg = loadConfig(E2E);
  const badCaps = JSON.parse(JSON.stringify(capsLib.DEFAULTS));
  badCaps.roles.judge = { model: 'deepseek/strong' }; // 与 panel_strategist 同模型
  const v = capsLib.validate(badCaps, resolveEngine, cfg);
  assert(!v.ok && v.errors.some((e) => e.includes('distinct')), 'DoD④ judge=席位 配置被校验拒绝', v.errors[0]);
  const hostCaps = JSON.parse(JSON.stringify(capsLib.DEFAULTS));
  hostCaps.roles.panel_strategist = { model: 'host' };
  const v2 = capsLib.validate(hostCaps, resolveEngine, cfg);
  assert(!v2.ok && v2.errors.some((e) => e.includes('宿主订阅')), '席位用宿主订阅被拒绝(§14.3)', v2.errors[0]);
  // 写坏配置到运行目录,验证 runPanel 入口同样拒绝(DoD④ 端到端)
  const capsFile = path.join(ROOT, 'capabilities.jsonc');
  const hadCaps = fs.existsSync(capsFile);
  const backup = hadCaps ? fs.readFileSync(capsFile, 'utf8') : null;
  fs.writeFileSync(capsFile, JSON.stringify({ roles: { judge: { model: 'deepseek/strong' } } }));
  const { runPanel } = require(path.join(__dirname, '..', 'src', 'daemon', 'panel'));
  const pr = await runPanel('测试议题', cfg);
  assert(!!pr.error && pr.error.includes('校验失败'), 'DoD④ runPanel 入口拒绝坏配置', (pr.error || '').slice(0, 70));
  if (hadCaps) fs.writeFileSync(capsFile, backup); else fs.rmSync(capsFile);

  // ── 起测试 daemon(带对抗桩)──
  const daemon = spawn('node', [path.join(__dirname, '..', 'src', 'daemon', 'server.js')], {
    env: { ...process.env, SUPATHINK_PORT: String(PORT), SUPATHINK_TEST_ALWAYS_BLOCK: '1' }, stdio: 'ignore',
  });
  await sleep(600);

  // ── DoD②:对抗样例(Critic 永远 block)→ 上限 2 → 第三次放行 + 未决分歧,绝不死循环 ──
  const sid = 'dod2-adversarial';
  await post('/v1/hook/user-prompt', { session_id: sid, cwd: E2E, prompt: '/st:slow 该不该全仓梭哈?' });
  const b1 = await post('/v1/hook/stop', { session_id: sid, cwd: E2E, stop_hook_active: false, last_assistant_message: '草稿一' });
  const b2 = await post('/v1/hook/stop', { session_id: sid, cwd: E2E, stop_hook_active: true, last_assistant_message: '草稿二(修订)' });
  const b3 = await post('/v1/hook/stop', { session_id: sid, cwd: E2E, stop_hook_active: true, last_assistant_message: '草稿三(再修订)' });
  const b4 = await post('/v1/hook/stop', { session_id: sid, cwd: E2E, stop_hook_active: true, last_assistant_message: '草稿三(再修订)' });
  assert(b1.decision === 'block' && b2.decision === 'block', 'DoD② 前两轮如实拦截', `loops→2`);
  assert(!b3.decision && !b4.decision, 'DoD② 第三/四次放行,不死循环', JSON.stringify(b3));
  await sleep(500);
  const t = readTrace(sid);
  assert(t.some((e) => e.type === 'disagreement'), 'DoD② 撞上限落 disagreement 事件(P7)', (t.find((e) => e.type === 'disagreement') || {}).resolution);
  const inj = await post('/v1/hook/user-prompt', { session_id: sid, cwd: E2E, prompt: '继续' });
  const ctx = inj.hookSpecificOutput ? inj.hookSpecificOutput.additionalContext || '' : '';
  assert(ctx.includes('未决分歧') || ctx.includes('Judge'), '未决分歧于下一轮呈现', ctx.slice(0, 80).replace(/\n/g, ' '));
  daemon.kill();

  // ── panel-lite 全链(真实 deepseek 强档)+ panel 缺席报告 + altitude ──
  const d2 = spawn('node', [path.join(__dirname, '..', 'src', 'daemon', 'server.js')], {
    env: { ...process.env, SUPATHINK_PORT: String(PORT) }, stdio: 'ignore',
  });
  await sleep(600);
  const sidP = 'dod-panel';
  const ack = await post('/v1/hook/user-prompt', { session_id: sidP, cwd: E2E, prompt: 'SUPATHINK_PANEL=lite\n\n先做移动端还是先做开放 API?' });
  assert((ack.hookSpecificOutput || {}).additionalContext.includes('后台运行'), 'panel-lite 发起轮 ack');
  let pend = [];
  for (let w = 0; w < 90; w++) { await sleep(1000); try { pend = JSON.parse(fs.readFileSync(path.join(ROOT, 'sessions', sidP, 'state.json'), 'utf8')).pending_findings || []; if (pend.length) break; } catch (_) {} }
  assert(pend.some((p) => p.includes('panel-lite 综合')), 'panel-lite 综合产出并入待呈现', (pend[0] || '').slice(0, 60).replace(/\n/g, ' '));
  const ackP = await post('/v1/hook/user-prompt', { session_id: sidP, cwd: E2E, prompt: 'SUPATHINK_PANEL=panel\n\n同上议题' });
  let pend2 = [];
  for (let w = 0; w < 20; w++) { await sleep(500); try { pend2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'sessions', sidP, 'state.json'), 'utf8')).pending_findings || []; if (pend2.some((p) => p.includes('未能成组'))) break; } catch (_) {} }
  assert(pend2.some((p) => p.includes('未能成组') && p.includes('缺席')), 'panel 缺席时如实报告(而非降级凑数)', (pend2.find((p) => p.includes('未能成组')) || '').slice(0, 90));

  const sidA = 'dod-altitude';
  const ackA = await post('/v1/hook/user-prompt', { session_id: sidA, cwd: E2E, prompt: 'SUPATHINK_ALTITUDE=1\n\n帮我把公众号阅读量做到 10 万+' });
  assert((ackA.hookSpecificOutput || {}).additionalContext.includes('抬头'), '/st:altitude ack');
  await post('/v1/hook/stop', { session_id: sidA, cwd: E2E, stop_hook_active: false, last_assistant_message: '方案:第一步买量投放,第二步互推,建议你先做标题党测试,目标是把阅读量冲上去。' });
  let navSeen = false;
  for (let w = 0; w < 60; w++) { await sleep(1000); try { if (readTrace(sidA).some((e) => e.type === 'navigator_flag')) { navSeen = true; break; } } catch (_) {} }
  assert(navSeen, 'altitude 强制 Navigator 产出 navigator_flag(代理指标场景)', (readTrace(sidA).find((e) => e.type === 'navigator_flag') || {}).axis);

  d2.kill();
  console.log(fails ? `\n${fails} 项失败` : '\n全部通过');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('测试脚本异常:', e); process.exit(1); });
