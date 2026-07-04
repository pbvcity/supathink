#!/usr/bin/env node
'use strict';
// 回归:默认 off 不能被旧协议/旧缓存通过 self_judged 或 CLI escalation 绕过。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 7801;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP_HOME = '/tmp/supathink-default-off-home';
const ROOT = path.join(TMP_HOME, '.supathink');
const CWD_OFF = '/tmp/supathink-default-off-proj';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (route, body) => (await fetch(`${BASE}${route}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})).json();
const assert = (ok, name, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
};

(async () => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  fs.mkdirSync(CWD_OFF, { recursive: true });
  fs.rmSync(path.join(CWD_OFF, '.supathink.json'), { force: true });

  const daemon = spawn('node', [path.join(__dirname, '..', 'src', 'daemon', 'server.js')], {
    env: { ...process.env, HOME: TMP_HOME, SUPATHINK_PORT: String(PORT) },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 20; i++) {
      try {
        const hz = await fetch(`${BASE}/healthz`).then((r) => r.json());
        if (hz.ok) break;
      } catch (_) { /* wait */ }
      await sleep(100);
    }

    const ro = await post('/v1/review', {
      agent: '__default_off__',
      session_id: 'selfjudged-off',
      transport: 'openclaw-plugin',
      self_judged: true,
      prompt: '高风险决策,但 agent 没开 auto',
      draft: '结论:直接做。',
    });
    assert(ro.verdict === 'pass' && ro.skipped === 'agent_policy_off', 'OpenClaw 默认 off 拒绝 self_judged 绕过', JSON.stringify(ro));

    const sid = 'escalate-off';
    await post('/v1/hook/session-start', { session_id: sid, cwd: CWD_OFF });
    await post('/v1/hook/user-prompt', { session_id: sid, cwd: CWD_OFF, prompt: '普通默认 off 轮' });
    const escDir = path.join(ROOT, 'escalations');
    const escSlug = CWD_OFF.replace(/[\/\\]/g, '-').replace(/^-+/, '') || 'unknown';
    fs.mkdirSync(escDir, { recursive: true });
    fs.writeFileSync(path.join(escDir, `${escSlug}.json`), JSON.stringify({ mode: 'full', methods: 'Pre-mortem', cwd: CWD_OFF, ts: Date.now() }));
    await post('/v1/hook/stop', { session_id: sid, cwd: CWD_OFF, stop_hook_active: false, last_assistant_message: 'ok' });
    const trace = fs.readFileSync(path.join(ROOT, 'sessions', sid, 'trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert(
      trace.some((e) => e.type === 'escalation_ignored' && e.reason === 'auto_off') &&
        !trace.some((e) => e.type === 'route_decision' && (e.triggers || []).includes('proposer_self_judged')),
      'Codex/Claude 默认 off 丢弃旧 CLI 升档文件',
      trace.map((e) => e.type).join(',')
    );
  } finally {
    daemon.kill();
  }
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
