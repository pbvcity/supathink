#!/usr/bin/env node
'use strict';
// 回归:默认 off 不能被旧协议/旧缓存通过 self_judged 或 CLI escalation 绕过。
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const { detectPanel } = require('../src/lib/config');

const PORT = 7801;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP_HOME = '/tmp/supathink-default-off-home';
const ROOT = path.join(TMP_HOME, '.supathink');
const CWD_OFF = '/tmp/supathink-default-off-proj';
const STUB_BIN = path.join(TMP_HOME, 'bin');
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
  fs.mkdirSync(STUB_BIN, { recursive: true });
  fs.mkdirSync(CWD_OFF, { recursive: true });
  fs.rmSync(path.join(CWD_OFF, '.supathink.json'), { force: true });
  fs.writeFileSync(path.join(STUB_BIN, 'codex'), `#!/usr/bin/env bash
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-last-message" ]; then
    shift
    out="$1"
  fi
  shift || break
done
mkdir -p "$(dirname "$out")"
printf '%s\n' '{"claims":[],"annotations":[],"checked_categories":["inference"],"verdict":"pass","reason":"stub"}' > "$out"
exit 0
`);
  fs.writeFileSync(path.join(STUB_BIN, 'claude'), `#!/usr/bin/env bash
echo "claude stub should not be called from Codex fallback" >&2
exit 42
`);
  fs.chmodSync(path.join(STUB_BIN, 'codex'), 0o755);
  fs.chmodSync(path.join(STUB_BIN, 'claude'), 0o755);

  const daemon = spawn('node', [path.join(__dirname, '..', 'src', 'daemon', 'server.js')], {
    env: { ...process.env, HOME: TMP_HOME, SUPATHINK_PORT: String(PORT), PATH: `${STUB_BIN}:${process.env.PATH || ''}` },
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

    fs.writeFileSync(path.join(ROOT, 'DISABLED'), '');
    const disabledPrompt = await post('/v1/hook/user-prompt', { session_id: 'disabled', cwd: CWD_OFF, prompt: '/st:slow 该不该迁生产?' });
    const disabledReview = await post('/v1/review', { session_id: 'disabled-review', cwd: CWD_OFF, prompt: '/st:slow', draft: '结论:直接做。' });
    const disabledPanel = await post('/v1/panel', { cwd: CWD_OFF, question: '要不要 panel?' });
    assert(Object.keys(disabledPrompt).length === 0, 'DISABLED 下 hook 静默放行', JSON.stringify(disabledPrompt));
    assert(disabledReview.verdict === 'pass' && disabledReview.skipped === 'disabled', 'DISABLED 下 /v1/review 不审稿', JSON.stringify(disabledReview));
    assert(disabledPanel.error === 'supathink disabled', 'DISABLED 下 /v1/panel 不启动', JSON.stringify(disabledPanel));
    fs.rmSync(path.join(ROOT, 'DISABLED'), { force: true });

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

    const pbSid = 'playbook-default-off';
    const pbDir = path.join(ROOT, 'playbooks');
    fs.mkdirSync(pbDir, { recursive: true });
    fs.mkdirSync(path.join(ROOT, 'sessions', pbSid), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'sessions', pbSid, 'state.json'), JSON.stringify({
      turn: 1,
      cwd: CWD_OFF,
      last_prompt: '供应商 A 还是 B?',
      last_recipe: { mode: 'full', intent: 'decide', triggers: ['user_slow'], panel: false, source_prompt: '供应商 A 还是 B?' },
    }, null, 2));
    fs.writeFileSync(path.join(ROOT, 'sessions', pbSid, 'trace.jsonl'), '');
    const sug = await post('/v1/hook/user-prompt', { session_id: pbSid, cwd: CWD_OFF, prompt: '太对了,正是我要的!' });
    const sctx = (sug.hookSpecificOutput || {}).additionalContext || '';
    assert(sctx.includes('playbook-save'), '默认 off 强认可仍弹 playbook 本地提议', sctx);
    const sv = await post('/v1/hook/user-prompt', { session_id: pbSid, cwd: CWD_OFF, prompt: '/st:playbook-save 供应商选型 此类决策' });
    const svctx = (sv.hookSpecificOutput || {}).additionalContext || '';
    assert(svctx.includes('已保存'), '默认 off /st:playbook-save 仍可写入', svctx);
    const svHyphen = await post('/v1/hook/user-prompt', { session_id: pbSid, cwd: CWD_OFF, prompt: '/st-playbook-save 供应商选型2 此类决策' });
    const svHyphenCtx = (svHyphen.hookSpecificOutput || {}).additionalContext || '';
    assert(svHyphenCtx.includes('已保存'), '默认 off /st-playbook-save 仍可写入', svHyphenCtx);

    const forceSid = 'force-with-approval-word';
    fs.mkdirSync(path.join(ROOT, 'sessions', forceSid), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'sessions', forceSid, 'state.json'), JSON.stringify({
      turn: 1,
      cwd: CWD_OFF,
      last_recipe: { mode: 'full', intent: 'decide', triggers: ['user_slow'], panel: false },
    }, null, 2));
    fs.writeFileSync(path.join(ROOT, 'sessions', forceSid, 'trace.jsonl'), '');
    const forceSug = await post('/v1/hook/user-prompt', { session_id: forceSid, cwd: CWD_OFF, prompt: '/st:slow 你上次说得太对了,深入评估要不要迁生产?' });
    const forceCtx = (forceSug.hookSpecificOutput || {}).additionalContext || '';
    assert(forceCtx.includes('建议思考方法') && !forceCtx.includes('playbook-save'), '/st:slow 含强认可词仍优先进入 full 菜单', forceCtx);
    assert(detectPanel('SUPATHINK_PANEL=panel-lite 议题') === 'lite', 'SUPATHINK_PANEL=panel-lite 标记识别为 lite');
    const panelLite = await post('/v1/hook/precmd', { session_id: 'panel-lite-strip', cwd: CWD_OFF, prompt: 'SUPATHINK_PANEL=panel-lite 测试议题' });
    const panelLiteCtx = panelLite.additionalContext || '';
    assert(panelLiteCtx.includes('议题:「测试议题」') && !panelLiteCtx.includes('-lite 测试议题'), 'SUPATHINK_PANEL=panel-lite 剥离题目前缀', panelLiteCtx);

    const codexSid = 'codex-host-fallback';
    await post('/v1/hook/session-start', { session_id: codexSid, cwd: CWD_OFF, model: 'gpt-5.4-mini', transcript_path: '/tmp/rollout-codex-host-fallback.jsonl' });
    await post('/v1/hook/user-prompt', { session_id: codexSid, cwd: CWD_OFF, prompt: '/st:slow 该不该迁到自建机房?', model: 'gpt-5.4-mini' });
    await post('/v1/hook/stop', { session_id: codexSid, cwd: CWD_OFF, model: 'gpt-5.4-mini', stop_hook_active: false, last_assistant_message: '本轮采用 决策矩阵。建议暂不迁,因为成本和运维风险高。' });
    const codexTrace = fs.readFileSync(path.join(ROOT, 'sessions', codexSid, 'trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const codexFinal = codexTrace.filter((e) => e.type === 'final_delivered').slice(-1)[0] || {};
    const quotaLines = fs.readFileSync(path.join(ROOT, 'quota.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const criticRun = quotaLines.filter((e) => e.session_id === codexSid && e.event === 'critic_run').slice(-1)[0] || {};
    assert(codexFinal.critic_status === 'pass' && criticRun.backend === 'gpt54mini', 'Codex 无 DeepSeek key 时 full 审稿回退 gpt-5.4-mini', JSON.stringify({ final: codexFinal.critic_status, backend: criticRun.backend }));

    const fakeDsPort = 7819;
    const fakeDsCalls = [];
    const fakeDs = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let prompt = '';
        try {
          const parsed = JSON.parse(body || '{}');
          prompt = (((parsed.messages || [])[0] || {}).content) || '';
        } catch (_) {}
        fakeDsCalls.push({ url: req.url, prompt });
        const isNavigator = prompt.includes('Navigator');
        const content = isNavigator
          ? '{"flags":[{"axis":"goal_traceback","severity":"major","issue":"目标已久未确认","ask":"这个目标仍然是你要的吗?"}]}'
          : '{}';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 1 } }));
      });
    });
    await new Promise((resolve) => fakeDs.listen(fakeDsPort, '127.0.0.1', resolve));
    try {
      fs.writeFileSync(path.join(ROOT, 'env'), [
        'SUPATHINK_DEEPSEEK_API_KEY=REAL_TEST_KEY',
        `SUPATHINK_DEEPSEEK_BASE_URL=http://127.0.0.1:${fakeDsPort}/v1`,
        'SUPATHINK_DEEPSEEK_MODEL=deepseek-v4-flash',
      ].join('\n') + '\n');
      fs.writeFileSync(path.join(ROOT, 'openclaw.json'), JSON.stringify({ default: 'auto', agents: {} }, null, 2));
      const ocSid = 'openclaw-nav-state';
      for (let i = 1; i <= 5; i++) {
        await post('/v1/hook/precmd', { session_id: ocSid, cwd: CWD_OFF, prompt: `第 ${i} 轮:我想做一个发布方案,先给步骤` });
      }
      const ocState = JSON.parse(fs.readFileSync(path.join(ROOT, 'sessions', ocSid, 'state.json'), 'utf8'));
      assert((ocState.turns_since_goal_confirm || 0) >= 5 && ocState.ledger && ocState.ledger.current_action, 'OpenClaw precmd 维护 Navigator 目标账本状态', JSON.stringify({ turns: ocState.turns_since_goal_confirm, action: ocState.ledger.current_action && ocState.ledger.current_action.text }));
      const ocReview = await post('/v1/review', {
        session_id: ocSid,
        agent: 'agent-a',
        cwd: CWD_OFF,
        transport: 'openclaw-plugin',
        self_judged: true,
        prompt: '这个方案第一步怎么做?',
        draft: '这里是简短答复。',
      });
      assert((ocReview.nav_flags || []).some((f) => f.axis === 'goal_traceback') && fakeDsCalls.some((c) => c.prompt.includes('Navigator') && c.prompt.includes('目标账本')), 'OpenClaw review 将 ledger/staleGoal 传给 Navigator', JSON.stringify({ flags: ocReview.nav_flags || [], calls: fakeDsCalls.length }));
    } finally {
      await new Promise((resolve) => fakeDs.close(resolve));
    }
  } finally {
    daemon.kill();
  }
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
