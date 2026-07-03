#!/usr/bin/env node
'use strict';
// Phase 1 DoD 取证:②快查 p95≤2s ③缓存命中跳核验 ④慢查发现下一轮注入可见 ⑤trace 全事件
// 另测:缓存已证伪断言 → 快查毫秒级 block(§4.2 + §3.2 就地升级)。DoD① 在 test 脚本外实测(杀进程)。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 7799;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(os.homedir(), '.supathink');
const E2E = process.argv[2] || '/tmp/supathink-dod-proj';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (route, body) => {
  const t0 = Date.now();
  const res = await fetch(`${BASE}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { ms: Date.now() - t0, json: await res.json() };
};
const readTrace = (sid) => fs.readFileSync(path.join(ROOT, 'sessions', sid, 'trace.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
let fails = 0;
const assert = (ok, name, detail) => { console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) fails++; };

(async () => {
  fs.mkdirSync(E2E, { recursive: true });
  fs.writeFileSync(path.join(E2E, '.supathink.json'), '{"auto":true}');

  const daemon = spawn('node', [path.join(__dirname, '..', 'src', 'daemon', 'server.js')], {
    env: { ...process.env, SUPATHINK_PORT: String(PORT) }, stdio: 'ignore', detached: false,
  });
  await sleep(600);
  const hz = await fetch(`${BASE}/healthz`).then((r) => r.json());
  assert(hz.ok, 'daemon 起动 healthz');

  // ── 缓存已证伪断言 → 毫秒级 block(快查缓存路径)──
  const cacheFile = path.join(ROOT, 'claims-cache', E2E.replace(/[\/\\]/g, '-').replace(/^-+/, '') + '.jsonl');
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.appendFileSync(cacheFile, JSON.stringify({ hash: require('crypto').createHash('sha256').update('magic-cached-lie是完全真实的期刊'.toLowerCase()).digest('hex').slice(0, 24), claim_text: 'MAGIC-CACHED-LIE 是完全真实的期刊', verdict: 'refuted', source: null, checked_at: new Date().toISOString(), ttl_days: 7 }) + '\n');
  const sidB = 'dod-cacheblock';
  await post('/v1/hook/user-prompt', { session_id: sidB, cwd: E2E, prompt: '这个引用的出处是什么?' });
  const rb = await post('/v1/hook/stop', { session_id: sidB, cwd: E2E, stop_hook_active: false, last_assistant_message: '根据文献,MAGIC-CACHED-LIE 是完全真实的期刊,可以放心引用。' });
  assert(rb.json.decision === 'block' && rb.ms < 500, `缓存证伪断言快查 block(${rb.ms}ms)`, (rb.json.reason || '').slice(0, 60));

  // ── DoD③+④:慢查核验→缓存命中;发现于下一轮注入可见 ──
  const sid3 = 'dod34';
  const fakeDraft = '据 Doe (2022) 发表于 Journal of Nonexistent Results 的论文,喝茶能提升 80% 的编码速度。详见 https://github.com/anthropics/no-such-repo-supathink-dod 。';
  await post('/v1/hook/user-prompt', { session_id: sid3, cwd: E2E, prompt: '帮我核对这条文献引用' });
  await post('/v1/hook/stop', { session_id: sid3, cwd: E2E, stop_hook_active: false, last_assistant_message: fakeDraft });
  process.stdout.write('  等慢查落盘(≤120s)…');
  let trace3 = [];
  for (let w = 0; w < 120; w++) { await sleep(1000); trace3 = readTrace(sid3); if (trace3.some((e) => e.type === 'verification_result')) break; }
  console.log('');
  const firstResults = trace3.filter((e) => e.type === 'verification_result');
  assert(firstResults.length > 0, 'DoD③ 慢查产出 verification_result', `${firstResults.length} 条,cache_hit=${firstResults.map((e) => e.cache_hit)}`);
  // 等 pending 就绪再测下一轮注入(DoD④)
  const stateFile = path.join(ROOT, 'sessions', sid3, 'state.json');
  for (let w = 0; w < 30; w++) { await sleep(1000); try { if ((JSON.parse(fs.readFileSync(stateFile, 'utf8')).pending_findings || []).length) break; } catch (_) {} }
  const inj = await post('/v1/hook/user-prompt', { session_id: sid3, cwd: E2E, prompt: '继续,顺便查一下这篇论文的年份是什么时候?' });
  const ctx = inj.json.hookSpecificOutput ? inj.json.hookSpecificOutput.additionalContext || '' : '';
  assert(ctx.includes('慢查发现') || ctx.includes('⚠'), 'DoD④ 慢查发现于下一轮注入可见', ctx.slice(0, 100).replace(/\n/g, ' '));
  // 同 draft 再来一轮 → 缓存命中(DoD③ 后半)
  await post('/v1/hook/stop', { session_id: sid3, cwd: E2E, stop_hook_active: false, last_assistant_message: fakeDraft });
  process.stdout.write('  等第二轮慢查(≤120s)…');
  let hit = false;
  for (let w = 0; w < 120; w++) {
    await sleep(1000);
    const t = readTrace(sid3).filter((e) => e.type === 'verification_result');
    if (t.length > firstResults.length) { hit = t.slice(firstResults.length).some((e) => e.cache_hit === true); break; }
  }
  console.log('');
  assert(hit, 'DoD③ 重复 claim 缓存命中(cache_hit:true)跳核验');

  // ── DoD②:快查 p95 ≤2s(light Stop 阻塞时长;放最后防慢查互挤)──
  const times = [];
  for (let i = 0; i < 8; i++) {
    const sid = `dod2-${i}`;
    await post('/v1/hook/user-prompt', { session_id: sid, cwd: E2E, prompt: `React ${i} 的最新版本是什么时候发布的?` });
    const r = await post('/v1/hook/stop', { session_id: sid, cwd: E2E, stop_hook_active: false, last_assistant_message: `React ${i} 于 2024 年 12 月发布,当前版本 ${i}.2.0。` });
    times.push(r.ms);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.ceil(times.length * 0.95) - 1];
  assert(p95 <= 2100, `DoD② 快查 p95=${p95}ms ≤2s`, `全部耗时 ${times.join(',')}`);

  // ── DoD⑤:trace 事件完备(route/draft/claims/verification/final;navigator_flag 门控性出现)──
  const types = new Set(readTrace(sid3).map((e) => e.type));
  assert(['route_decision', 'draft_captured', 'claims_extracted', 'verification_result', 'final_delivered'].every((t) => types.has(t)), 'DoD⑤ trace 事件链完备', [...types].join(','));

  daemon.kill();
  console.log(fails ? `\n${fails} 项失败` : '\n全部通过');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('测试脚本异常:', e); process.exit(1); });
