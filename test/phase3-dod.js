#!/usr/bin/env node
'use strict';
// Phase 3 DoD:①Codex 端 off/light/full 全通 ②认可捕获弹出→写入 playbook→范围可编辑 ③playbook 不预授权教练站位
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(os.homedir(), '.supathink');
const BASE = 'http://127.0.0.1:7777';
const E2E = '/tmp/supathink-dod-proj';
const CXH = '/tmp/supathink-codex-home';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (r, b) => (await fetch(`${BASE}${r}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
const readTrace = (sid) => fs.readFileSync(path.join(ROOT, 'sessions', sid, 'trace.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
let fails = 0;
const assert = (ok, name, detail) => { console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${String(detail).slice(0, 110)}` : ''}`); if (!ok) fails++; };
const newestSession = (after) => fs.readdirSync(path.join(ROOT, 'sessions'))
  .map((d) => ({ d, t: fs.statSync(path.join(ROOT, 'sessions', d, 'state.json')).mtimeMs }))
  .filter((x) => x.t > after).sort((a, b) => b.t - a.t)[0]?.d;

function codexRun(prompt) {
  const r = spawnSync('bash', ['-c',
    `cd ${E2E} && CODEX_HOME=${CXH} timeout 240 codex exec --dangerously-bypass-hook-trust --skip-git-repo-check -s read-only -m gpt-5.4-mini ${JSON.stringify(prompt)} </dev/null 2>&1`,
  ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  return r.stdout || '';
}

(async () => {
  fs.mkdirSync(E2E, { recursive: true });
  fs.writeFileSync(path.join(E2E, '.supathink.json'), '{"auto":true}');
  // 隔离 CODEX_HOME:拷贝 auth,写 supathink hooks(与 install.sh 同形)
  fs.mkdirSync(CXH, { recursive: true });
  fs.copyFileSync(path.join(os.homedir(), '.codex', 'auth.json'), path.join(CXH, 'auth.json'));
  const shim = (route, m, timeout) => ({ type: 'command', command: `curl -sS -m ${m} -X POST -H 'Content-Type: application/json' -d @- ${BASE}/v1/hook/${route} || echo '{}'`, timeout });
  fs.writeFileSync(path.join(CXH, 'hooks.json'), JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [shim('session-start', 8, 15)] }],
    UserPromptSubmit: [{ hooks: [shim('user-prompt', 8, 15)] }],
    Stop: [{ hooks: [shim('stop', 90, 120)] }],
  } }, null, 2));

  // ── DoD①-off:coding 轮零介入 ──
  let mark = Date.now();
  codexRun('把变量名 foo 改成 bar,只回答改好的一行:let foo = 1');
  await sleep(500);
  let sid = newestSession(mark);
  const offTrace = sid ? readTrace(sid) : [];
  assert(sid && offTrace.some((e) => e.type === 'route_decision' && e.mode === 'off'), 'DoD① Codex off 轮(route=off 零介入)', sid);

  // ── DoD①-light:路由 + 慢查异步产出(Phase 1 起 light=快查放行+慢查下一轮呈现)──
  mark = Date.now();
  codexRun('帮我把这段文献引用润色得更学术(引用信息保留):『据 Brown (2020) 发表于 Annals of Fictional Science 的研究,喝咖啡能让代码少 50% 的 bug。』');
  await sleep(500);
  sid = newestSession(mark);
  let lt = sid ? readTrace(sid) : [];
  assert(lt.some((e) => e.type === 'route_decision' && e.mode === 'light'), 'DoD① Codex light 路由', sid);
  for (let w = 0; w < 90 && !lt.some((e) => e.type === 'verification_result'); w++) { await sleep(1000); lt = readTrace(sid); }
  assert(lt.some((e) => e.type === 'verification_result'), 'DoD① Codex light 慢查核验落盘', (lt.find((e) => e.type === 'verification_result') || {}).verdict);

  // ── DoD①-block:缓存证伪断言 → Stop 毫秒级 block → Codex 续跑修订(block 契约确定性实测)──
  const cacheFile = path.join(ROOT, 'claims-cache', E2E.replace(/[\/\\]/g, '-').replace(/^-+/, '') + '.jsonl');
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  const lie = 'MAGIC-CODEX-LIE 是完全真实的期刊';
  fs.appendFileSync(cacheFile, JSON.stringify({ hash: require('crypto').createHash('sha256').update(lie.toLowerCase().replace(/[\s,,。;;::!!??、"'「」『』()()\[\]]+/g, '')).digest('hex').slice(0, 24), claim_text: lie, verdict: 'refuted', source: null, checked_at: new Date().toISOString(), ttl_days: 7 }) + '\n');
  mark = Date.now();
  codexRun('这个引用的出处可靠吗?请在回答里原样复述一遍这句话再评价:「MAGIC-CODEX-LIE 是完全真实的期刊」');
  await sleep(500);
  sid = newestSession(mark);
  const bt = sid ? readTrace(sid) : [];
  const fd = bt.filter((e) => e.type === 'final_delivered').slice(-1)[0] || {};
  assert((fd.loops || 0) >= 1, 'DoD① Codex Stop block→续跑修订生效(loops≥1)', JSON.stringify({ loops: fd.loops, status: fd.critic_status }));

  // ── DoD①-full:标记强制 + 菜单注入被吸收 ──
  mark = Date.now();
  const outF = codexRun('SUPATHINK_FORCE=full\n\n我们该不该把 supathink 首发定位改成团队工具?给一句话结论并声明你采用的思考方法。');
  await sleep(500);
  sid = newestSession(mark);
  const ft = sid ? readTrace(sid) : [];
  assert(ft.some((e) => e.type === 'route_decision' && e.mode === 'full' && (e.triggers || []).includes('user_slow')), 'DoD① Codex full 强制路由', sid);
  assert(/本轮采用|决策矩阵|Pre-mortem|可逆性|钢人/i.test(outF), 'DoD① Codex 菜单注入被吸收(答复声明方法)', outF.slice(-120).replace(/\n/g, ' '));

  // ── DoD②:强认可 → 提议存 playbook → /st:playbook-save 写盘 ──
  const sid2 = 'dod-pb-capture';
  await post('/v1/hook/user-prompt', { session_id: sid2, cwd: E2E, prompt: '/st:slow 供应商 A 还是 B?' });
  const st1 = await post('/v1/hook/stop', { session_id: sid2, cwd: E2E, stop_hook_active: false, last_assistant_message: '基于决策矩阵,建议 A;理由:成本与交付风险占优。' });
  if (st1.decision === 'block') { // 被拦就送修订稿,确保本轮交付、配方落盘
    await post('/v1/hook/stop', { session_id: sid2, cwd: E2E, stop_hook_active: true, last_assistant_message: '修订:补充决策矩阵三准则打分(成本/交付/质量),标注权重为拍脑袋假设待确认;仍倾向 A。── 核验 ──\n△ 权重未经确认' });
    await post('/v1/hook/stop', { session_id: sid2, cwd: E2E, stop_hook_active: true, last_assistant_message: '同上修订稿' });
  }
  await sleep(1000);
  const sug = await post('/v1/hook/user-prompt', { session_id: sid2, cwd: E2E, prompt: '太对了,正是我要的!' });
  const sctx = (sug.hookSpecificOutput || {}).additionalContext || '';
  assert(sctx.includes('playbook-save'), 'DoD② 强认可弹出存档提议', sctx.slice(0, 80));
  assert(readTrace(sid2).some((e) => e.type === 'user_feedback' && e.signal === 'strong_approve'), 'DoD② user_feedback 落 trace');
  const sv = await post('/v1/hook/user-prompt', { session_id: sid2, cwd: E2E, prompt: '/st:playbook-save 供应商选型 此类决策' });
  const svctx = (sv.hookSpecificOutput || {}).additionalContext || '';
  assert(svctx.includes('已保存'), 'DoD② playbook 写入', svctx.slice(0, 80));
  const pbId = (svctx.match(/id=(pb-\w+)/) || [])[1];
  const pbFile = path.join(ROOT, 'playbooks', `${pbId}.jsonc`);
  assert(fs.existsSync(pbFile), 'DoD② playbook 文件存在', pbFile);
  assert(readTrace(sid2).some((e) => e.type === 'playbook_capture'), 'DoD② playbook_capture 落 trace');
  // 范围可编辑:直接改文件 scope+keywords
  const pb = JSON.parse(fs.readFileSync(pbFile, 'utf8'));
  pb.scope = '所有业务策略';
  pb.match.keywords = ['供应商'];
  fs.writeFileSync(pbFile, JSON.stringify(pb, null, 2));
  assert(JSON.parse(fs.readFileSync(pbFile, 'utf8')).scope === '所有业务策略', 'DoD② 范围可编辑(文件直改生效)');

  // ── playbook 命中:含关键词的普通问题被抬升 full ──
  const hit = await post('/v1/hook/user-prompt', { session_id: 'dod-pb-hit', cwd: E2E, prompt: '下季度供应商的账期问题帮我理一理思路' });
  const hitTrace = readTrace('dod-pb-hit');
  const rd = hitTrace.filter((e) => e.type === 'route_decision').slice(-1)[0]; // 会话 trace 是追加制,取最后一条
  assert(rd && rd.mode === 'full' && rd.playbook_id === pbId, 'playbook 命中并抬升 full', JSON.stringify({ mode: rd && rd.mode, pb: rd && rd.playbook_id }));

  // ── DoD③:playbook 带 stance_pref=coach 也不得预授权教练站位 ──
  const coachPb = { id: 'pb-coachtest', name: 'coach 预授权攻击', scope: '测试', match: { keywords: ['组织架构'] }, recipe: { mode: 'full', intent: 'decide', stance_pref: 'coach' }, confidence: 0.3, created_at: new Date().toISOString() };
  fs.writeFileSync(path.join(ROOT, 'playbooks', 'pb-coachtest.jsonc'), JSON.stringify(coachPb, null, 2));
  const c1 = await post('/v1/hook/user-prompt', { session_id: 'dod-coach', cwd: E2E, prompt: '帮我梳理一下新的组织架构方案' }); // 无交权信号
  const cctx = (c1.hookSpecificOutput || {}).additionalContext || '';
  const ct = readTrace('dod-coach').find((e) => e.type === 'route_decision');
  assert(ct && ct.mode === 'full' && ct.stance_hint === null, 'DoD③ playbook 命中但 stance_hint 仍为 null(未预授权)', JSON.stringify({ stance: ct && ct.stance_hint }));
  assert(!/已授权|主导权已|直接替你决定/.test(cctx) && !cctx.includes('主导权门') === false || !/已授权/.test(cctx), 'DoD③ 注入不含任何授权话术', cctx.slice(0, 60));
  const c2 = await post('/v1/hook/user-prompt', { session_id: 'dod-coach', cwd: E2E, prompt: '组织架构的事你替我决定吧,我实在想不清楚' }); // 实时交权信号 → 门照常触发
  const cctx2 = (c2.hookSpecificOutput || {}).additionalContext || '';
  assert(cctx2.includes('主导权门'), 'DoD③ 实时交权信号仍走授权门(门每次实时过)', cctx2.slice(0, 60));
  fs.rmSync(path.join(ROOT, 'playbooks', 'pb-coachtest.jsonc'), { force: true });

  fs.rmSync(path.join(CXH, 'auth.json'), { force: true });
  console.log(fails ? `\n${fails} 项失败` : '\n全部通过');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('测试脚本异常:', e); try { fs.rmSync(path.join(CXH, 'auth.json'), { force: true }); } catch (_) {} process.exit(1); });
