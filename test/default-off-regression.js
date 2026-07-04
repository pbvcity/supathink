#!/usr/bin/env node
'use strict';
// 回归:默认 off 不能被旧协议/旧缓存通过 self_judged 或 CLI escalation 绕过。
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const { detectPanel } = require('../src/lib/config');
const { route } = require('../src/lib/router');

const PORT = 7801;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP_HOME = '/tmp/supathink-default-off-home';
const ROOT = path.join(TMP_HOME, '.supathink');
const CWD_OFF = '/tmp/supathink-default-off-proj';
const STUB_BIN = path.join(TMP_HOME, 'bin');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJsonRetry = async (file, tries = 20) => {
  let lastError = null;
  for (let i = 0; i < tries; i++) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      lastError = error;
      await sleep(15);
    }
  }
  throw lastError;
};
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
    const debateStrip = await post('/v1/hook/precmd', { session_id: 'debate-strip', cwd: CWD_OFF, prompt: 'SUPATHINK_PANEL=debate 测试辩题' });
    const debateStripCtx = debateStrip.additionalContext || '';
    assert(debateStripCtx.includes('议题:「测试辩题」') && !debateStripCtx.includes('SUPATHINK_PANEL=debate'), 'SUPATHINK_PANEL=debate 剥离题目前缀', debateStripCtx);

    fs.writeFileSync(path.join(ROOT, 'openclaw.json'), JSON.stringify({ default: 'auto', agents: {} }, null, 2));
    const ocMenu = await post('/v1/hook/precmd', { session_id: 'openclaw-auto-method-menu', agent: 'agent-a', cwd: CWD_OFF, prompt: '我的某个持仓是否值得长持?' });
    const ocMenuCtx = ocMenu.additionalContext || '';
    assert(ocMenuCtx.includes('建议思考方法') && ocMenuCtx.includes('决策矩阵'), 'OpenClaw auto 决策题生成前注入方法菜单', ocMenuCtx);
    const stockRoute = route('我的某个持仓是否值得长持');
    const englishStockRoute = route('Is my NVDA position worth holding long term?');
    const englishTickerRoute = route('Is NVDA worth holding long term?');
    const englishHoldingRoute = route('Is my holding worth long-term holding?');
    const englishPositionInRoute = route('Is my position in NVDA worth holding long term?');
    assert(stockRoute.mode === 'full' && stockRoute.triggers.includes('decision_language'), '是否值得长持 命中 full 决策门控', JSON.stringify(stockRoute));
    assert(englishStockRoute.mode === 'full' && englishStockRoute.triggers.includes('decision_language'), '英文持仓长持问法命中 full 决策门控', JSON.stringify(englishStockRoute));
    assert(
      englishTickerRoute.mode === 'full' && englishHoldingRoute.mode === 'full' && englishPositionInRoute.mode === 'full',
      '英文 ticker/holding/position in 长持问法命中 full 决策门控',
      JSON.stringify({ englishTickerRoute, englishHoldingRoute, englishPositionInRoute })
    );
    const needsRoute = route('确认一下参数是否需要加锁');
    const worthPraiseRoute = route('这个方案值得肯定，不用改了');
    const positionPaperRoute = route('This position paper is worth holding in mind long term.');
    assert(
      needsRoute.mode !== 'full' && worthPraiseRoute.mode !== 'full' && positionPaperRoute.mode !== 'full',
      '普通 是否需要/值得肯定/position paper 不误触发 full 决策门控',
      JSON.stringify({ needsRoute, worthPraiseRoute, positionPaperRoute })
    );
    const ocOffTraceSid = 'openclaw-auto-off-trace';
    await post('/v1/hook/precmd', { session_id: ocOffTraceSid, agent: 'agent-a', cwd: CWD_OFF, prompt: '谢谢,继续' });
    const ocOffTrace = fs.readFileSync(path.join(ROOT, 'sessions', ocOffTraceSid, 'trace.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert(ocOffTrace.some((e) => e.type === 'route_decision' && e.mode === 'off'), 'OpenClaw auto=true 但 route=off 也记录 route_decision trace', ocOffTrace.map((e) => `${e.type}:${e.mode || ''}`).join(','));

    const deliverySid = 'openclaw-debate-delivery';
    fs.mkdirSync(path.join(ROOT, 'sessions', deliverySid), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'sessions', deliverySid, 'trace.jsonl'), '');
    fs.writeFileSync(path.join(ROOT, 'sessions', deliverySid, 'state.json'), JSON.stringify({
      turn: 3,
      cwd: CWD_OFF,
      host: 'openclaw',
      pending_findings: ['【debate 综合(全文见 supathink log / panel-3.json)】Judge 裁决:不建议无条件长持,需要重新看基本面与仓位风险。'],
      pending_deliveries: [{
        id: 'bg-3-debate',
        source: 'supathink',
        event_type: 'background_result_ready',
        method: 'debate',
        requires_visible_delivery: true,
        user_visible_task: '基于后台综合结果,向用户输出独立可见的最终结论',
        original_user_message_id: '3',
        original_topic: '某持仓是否长持',
        result_file: 'panel-3.json',
        result_summary: 'Judge 裁决:不建议无条件长持,需要重新看基本面与仓位风险。',
        delivery_contract: 'send_standalone_final_answer',
        status: 'result_ready',
      }],
    }, null, 2));
    const delivery = await post('/v1/hook/precmd', { session_id: deliverySid, agent: 'agent-a', cwd: CWD_OFF, prompt: '为什么刚才不等后台 debate?' });
    const deliveryCtx = delivery.additionalContext || '';
    assert(delivery.requiresVisibleDelivery === true && deliveryCtx.includes('后台结果已完成') && deliveryCtx.includes('delivery_contract: send_standalone_final_answer') && deliveryCtx.includes('不是用户原话'), 'OpenClaw 后台 debate 结果强制独立可见交付', deliveryCtx);
    const badAck = await post('/v1/hook/message-sent', { session_id: deliverySid, content: '因为规则要求我不要等待后台 debate,所以我先回复你。' });
    const deliveryStateAfterBadAck = JSON.parse(fs.readFileSync(path.join(ROOT, 'sessions', deliverySid, 'state.json'), 'utf8'));
    assert(
      badAck.delivered === 0 && badAck.pending === 1 && (deliveryStateAfterBadAck.pending_deliveries || []).length === 1,
      '未独立交付的后台结果只记 attempted 并重新排队',
      JSON.stringify(badAck)
    );
    const retryDelivery = await post('/v1/hook/precmd', { session_id: deliverySid, agent: 'agent-a', cwd: CWD_OFF, prompt: '请先交付刚才的后台结果' });
    const retryCtx = retryDelivery.additionalContext || '';
    assert(retryDelivery.requiresVisibleDelivery === true && retryCtx.includes('后台结果已完成'), 'attempted 后下一轮继续强制交付后台结果', retryCtx);
    const ruleOnlyAck = await post('/v1/hook/message-sent', { session_id: deliverySid, content: '收到 debate 后台综合结果。我理解规则要求先说明为什么不等后台 debate。' });
    assert(ruleOnlyAck.delivered === 0 && ruleOnlyAck.pending === 1, '仅提到收到/规则说明不能伪满足后台交付契约', JSON.stringify(ruleOnlyAck));
    await post('/v1/hook/precmd', { session_id: deliverySid, agent: 'agent-a', cwd: CWD_OFF, prompt: '请继续交付后台结果' });
    const receiptOnlyAck = await post('/v1/hook/message-sent', { session_id: deliverySid, content: '收到 debate 后台综合结果。1. 后台裁决结论:收到。' });
    assert(receiptOnlyAck.delivered === 0 && receiptOnlyAck.pending === 1, '字段标题加“收到”不能伪满足后台交付契约', JSON.stringify(receiptOnlyAck));
    await post('/v1/hook/precmd', { session_id: deliverySid, agent: 'agent-a', cwd: CWD_OFF, prompt: '请给最终结论' });
    const goodAck = await post('/v1/hook/message-sent', { session_id: deliverySid, content: '收到 debate 后台综合结果。1. 后台裁决结论:不建议无条件长持。' });
    const deliveryTrace = fs.readFileSync(path.join(ROOT, 'sessions', deliverySid, 'trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert(
      goodAck.delivered === 1 &&
        deliveryTrace.some((e) => e.type === 'background_result_delivery_requested') &&
        deliveryTrace.some((e) => e.type === 'background_result_delivery_attempted' && e.contract_satisfied === false) &&
        deliveryTrace.some((e) => e.type === 'background_result_delivered'),
      '后台结果 trace 含 requested、attempted 与 delivered 状态',
      deliveryTrace.map((e) => e.type).join(',')
    );

    const failedPanelSid = 'openclaw-panel-lite-failed-delivery';
    await post('/v1/hook/precmd', { session_id: failedPanelSid, agent: 'agent-a', cwd: CWD_OFF, prompt: 'SUPATHINK_PANEL=panel-lite 测试失败路径' });
    await sleep(120);
    const failedPanelDelivery = await post('/v1/hook/precmd', { session_id: failedPanelSid, agent: 'agent-a', cwd: CWD_OFF, prompt: '继续' });
    const failedPanelCtx = failedPanelDelivery.additionalContext || '';
    assert(
      failedPanelDelivery.requiresVisibleDelivery === true &&
        failedPanelCtx.includes('event_type: background_result_failed') &&
        failedPanelCtx.includes('后台执行结果') &&
        failedPanelCtx.includes('panel-lite'),
      '后台合议失败也作为强制可见交付事件返回',
      failedPanelCtx
    );
    const fakeFailedAck = await post('/v1/hook/message-sent', {
      session_id: failedPanelSid,
      content: '收到 panel-lite 后台综合结果。1. 后台裁决结论:建议继续推进。4. 最终更新后的结论:可以做。',
    });
    assert(
      fakeFailedAck.delivered === 0 && fakeFailedAck.pending === 1,
      '失败后台结果不能被成功式结论伪交付',
      JSON.stringify(fakeFailedAck)
    );
    await post('/v1/hook/precmd', { session_id: failedPanelSid, agent: 'agent-a', cwd: CWD_OFF, prompt: '继续交付失败状态' });
    const fakeNoReasonAck = await post('/v1/hook/message-sent', {
      session_id: failedPanelSid,
      content: '收到 panel-lite 后台执行状态。1. 后台裁决结论:建议继续推进。2. 未完成原因:无。4. 最终更新后的结论:可以做。',
    });
    assert(
      fakeNoReasonAck.delivered === 0 && fakeNoReasonAck.pending === 1,
      '失败后台结果不能被“未完成原因:无”的成功式结论伪交付',
      JSON.stringify(fakeNoReasonAck)
    );
    await post('/v1/hook/precmd', { session_id: failedPanelSid, agent: 'agent-a', cwd: CWD_OFF, prompt: '请交付失败状态' });
    const goodFailedAck = await post('/v1/hook/message-sent', {
      session_id: failedPanelSid,
      content: '收到 panel-lite 后台执行状态。1. 后台执行结果:未能完成。2. 未完成原因:panel-lite 需要 deepseek 强档可用。3. 目前不能得出的结论:不能给出后台综合裁决。4. 建议用户下一步怎么处理:检查强档配置后重试。',
    });
    assert(
      goodFailedAck.delivered === 1 && goodFailedAck.pending === 0,
      '失败后台结果按失败模板说明后才标记 delivered',
      JSON.stringify(goodFailedAck)
    );

    const multiSid = 'openclaw-multi-delivery-method-match';
    fs.mkdirSync(path.join(ROOT, 'sessions', multiSid), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'sessions', multiSid, 'trace.jsonl'), '');
    fs.writeFileSync(path.join(ROOT, 'sessions', multiSid, 'state.json'), JSON.stringify({
      turn: 5,
      cwd: CWD_OFF,
      host: 'openclaw',
      pending_deliveries: [{
        id: 'bg-5-debate',
        source: 'supathink',
        event_type: 'background_result_ready',
        method: 'debate',
        requires_visible_delivery: true,
        user_visible_task: '基于后台综合结果,向用户输出独立可见的最终结论',
        original_user_message_id: '5',
        result_file: 'panel-5.json',
        result_summary: 'debate 综合:暂不建议迁移。',
        delivery_contract: 'send_standalone_final_answer',
        status: 'result_ready',
      }, {
        id: 'bg-5-panel',
        source: 'supathink',
        event_type: 'background_result_ready',
        method: 'panel',
        requires_visible_delivery: true,
        user_visible_task: '基于后台综合结果,向用户输出独立可见的最终结论',
        original_user_message_id: '5',
        result_file: 'panel-5b.json',
        result_summary: 'panel 综合:先做小规模试点。',
        delivery_contract: 'send_standalone_final_answer',
        status: 'result_ready',
      }],
    }, null, 2));
    await post('/v1/hook/precmd', { session_id: multiSid, agent: 'agent-a', cwd: CWD_OFF, prompt: '继续' });
    const multiAck = await post('/v1/hook/message-sent', { session_id: multiSid, content: '收到 debate 后台综合结果。1. 后台裁决结论:暂不建议迁移。' });
    const multiState = JSON.parse(fs.readFileSync(path.join(ROOT, 'sessions', multiSid, 'state.json'), 'utf8'));
    assert(
      multiAck.delivered === 1 && multiAck.pending === 1 && (multiState.pending_deliveries || []).some((d) => d.method === 'panel'),
      '多条后台结果必须按 method 独立匹配,未交付项保留',
      JSON.stringify({ ack: multiAck, pending: multiState.pending_deliveries })
    );

    const crossMethodLumpedSid = 'openclaw-cross-method-lumped-delivery';
    fs.mkdirSync(path.join(ROOT, 'sessions', crossMethodLumpedSid), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'sessions', crossMethodLumpedSid, 'trace.jsonl'), '');
    fs.writeFileSync(path.join(ROOT, 'sessions', crossMethodLumpedSid, 'state.json'), JSON.stringify({
      turn: 5,
      cwd: CWD_OFF,
      host: 'openclaw',
      pending_deliveries: [{
        id: 'bg-5-panel-lumped',
        source: 'supathink',
        event_type: 'background_result_ready',
        method: 'panel',
        requires_visible_delivery: true,
        user_visible_task: '基于后台综合结果,向用户输出独立可见的最终结论',
        original_user_message_id: '5',
        result_file: 'panel-5-lumped.json',
        result_summary: 'panel 综合:建议暂缓。',
        delivery_contract: 'send_standalone_final_answer',
        status: 'result_ready',
      }, {
        id: 'bg-5-debate-lumped',
        source: 'supathink',
        event_type: 'background_result_ready',
        method: 'debate',
        requires_visible_delivery: true,
        user_visible_task: '基于后台综合结果,向用户输出独立可见的最终结论',
        original_user_message_id: '5',
        result_file: 'debate-5-lumped.json',
        result_summary: 'debate 综合:建议暂缓。',
        delivery_contract: 'send_standalone_final_answer',
        status: 'result_ready',
      }],
    }, null, 2));
    await post('/v1/hook/precmd', { session_id: crossMethodLumpedSid, agent: 'agent-a', cwd: CWD_OFF, prompt: '继续' });
    const crossMethodLumpedAck = await post('/v1/hook/message-sent', {
      session_id: crossMethodLumpedSid,
      content: '收到 panel 和 debate 后台综合结果。1. 后台裁决结论:建议暂缓。',
    });
    const crossMethodLumpedState = JSON.parse(fs.readFileSync(path.join(ROOT, 'sessions', crossMethodLumpedSid, 'state.json'), 'utf8'));
    assert(
      crossMethodLumpedAck.delivered === 0 &&
        crossMethodLumpedAck.pending === 2 &&
        (crossMethodLumpedState.pending_deliveries || []).length === 2,
      '不同 method 多条后台结果不能被一条笼统合并回复全部标记 delivered',
      JSON.stringify({ ack: crossMethodLumpedAck, pending: crossMethodLumpedState.pending_deliveries })
    );

    const sameMethodSid = 'openclaw-same-method-delivery-specificity';
    fs.mkdirSync(path.join(ROOT, 'sessions', sameMethodSid), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'sessions', sameMethodSid, 'trace.jsonl'), '');
    fs.writeFileSync(path.join(ROOT, 'sessions', sameMethodSid, 'state.json'), JSON.stringify({
      turn: 5,
      cwd: CWD_OFF,
      host: 'openclaw',
      pending_deliveries: [{
        id: 'bg-5-debate-a',
        source: 'supathink',
        event_type: 'background_result_ready',
        method: 'debate',
        requires_visible_delivery: true,
        user_visible_task: '基于后台综合结果,向用户输出独立可见的最终结论',
        original_user_message_id: '5',
        result_file: 'panel-5-a.json',
        result_summary: 'debate 综合:第一结论需要降仓。',
        delivery_contract: 'send_standalone_final_answer',
        status: 'result_ready',
      }, {
        id: 'bg-5-debate-b',
        source: 'supathink',
        event_type: 'background_result_ready',
        method: 'debate',
        requires_visible_delivery: true,
        user_visible_task: '基于后台综合结果,向用户输出独立可见的最终结论',
        original_user_message_id: '5',
        result_file: 'panel-5-b.json',
        result_summary: 'debate 综合:第二结论需要补充对冲。',
        delivery_contract: 'send_standalone_final_answer',
        status: 'result_ready',
      }],
    }, null, 2));
    await post('/v1/hook/precmd', { session_id: sameMethodSid, agent: 'agent-a', cwd: CWD_OFF, prompt: '继续' });
    const sameMethodAck = await post('/v1/hook/message-sent', { session_id: sameMethodSid, content: '收到 debate 后台综合结果。1. 后台裁决结论:第一结论需要降仓。' });
    const sameMethodState = JSON.parse(fs.readFileSync(path.join(ROOT, 'sessions', sameMethodSid, 'state.json'), 'utf8'));
    assert(
      sameMethodAck.delivered === 1 &&
        sameMethodAck.pending === 1 &&
        (sameMethodState.pending_deliveries || []).some((d) => d.id === 'bg-5-debate-b'),
      '同 method 多条后台结果不能被单条局部交付全部标记 delivered',
      JSON.stringify({ ack: sameMethodAck, pending: sameMethodState.pending_deliveries })
    );

    const sharedEvidenceSid = 'openclaw-same-method-shared-summary-evidence';
    fs.mkdirSync(path.join(ROOT, 'sessions', sharedEvidenceSid), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'sessions', sharedEvidenceSid, 'trace.jsonl'), '');
    fs.writeFileSync(path.join(ROOT, 'sessions', sharedEvidenceSid, 'state.json'), JSON.stringify({
      turn: 5,
      cwd: CWD_OFF,
      host: 'openclaw',
      pending_deliveries: [{
        id: 'bg-5-debate-shared-a',
        source: 'supathink',
        event_type: 'background_result_ready',
        method: 'debate',
        requires_visible_delivery: true,
        user_visible_task: '基于后台综合结果,向用户输出独立可见的最终结论',
        original_user_message_id: '5',
        result_file: 'panel-5-shared-a.json',
        result_summary: 'debate 综合:暂不建议迁移,因为成本风险高。',
        delivery_contract: 'send_standalone_final_answer',
        status: 'result_ready',
      }, {
        id: 'bg-5-debate-shared-b',
        source: 'supathink',
        event_type: 'background_result_ready',
        method: 'debate',
        requires_visible_delivery: true,
        user_visible_task: '基于后台综合结果,向用户输出独立可见的最终结论',
        original_user_message_id: '5',
        result_file: 'panel-5-shared-b.json',
        result_summary: 'debate 综合:暂不建议迁移,因为监管风险高。',
        delivery_contract: 'send_standalone_final_answer',
        status: 'result_ready',
      }],
    }, null, 2));
    await post('/v1/hook/precmd', { session_id: sharedEvidenceSid, agent: 'agent-a', cwd: CWD_OFF, prompt: '继续' });
    const sharedEvidenceAck = await post('/v1/hook/message-sent', { session_id: sharedEvidenceSid, content: '收到 debate 后台综合结果。1. 后台裁决结论:暂不建议迁移。' });
    const sharedEvidenceState = JSON.parse(fs.readFileSync(path.join(ROOT, 'sessions', sharedEvidenceSid, 'state.json'), 'utf8'));
    assert(
      sharedEvidenceAck.delivered === 0 &&
        sharedEvidenceAck.pending === 2 &&
        (sharedEvidenceState.pending_deliveries || []).length === 2,
      '同 method 多条后台结果共享摘要片段时不能把共享片段当作专属证据',
      JSON.stringify({ ack: sharedEvidenceAck, pending: sharedEvidenceState.pending_deliveries })
    );

    const sharedFileSid = 'openclaw-same-method-shared-result-file';
    fs.mkdirSync(path.join(ROOT, 'sessions', sharedFileSid), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'sessions', sharedFileSid, 'trace.jsonl'), '');
    fs.writeFileSync(path.join(ROOT, 'sessions', sharedFileSid, 'state.json'), JSON.stringify({
      turn: 5,
      cwd: CWD_OFF,
      host: 'openclaw',
      pending_deliveries: [{
        id: 'bg-5-debate-file-a',
        source: 'supathink',
        event_type: 'background_result_ready',
        method: 'debate',
        requires_visible_delivery: true,
        user_visible_task: '基于后台综合结果,向用户输出独立可见的最终结论',
        original_user_message_id: '5',
        result_file: 'panel-5-shared.json',
        result_summary: 'debate 综合:暂不建议迁移,因为成本风险高。',
        delivery_contract: 'send_standalone_final_answer',
        status: 'result_ready',
      }, {
        id: 'bg-5-debate-file-b',
        source: 'supathink',
        event_type: 'background_result_ready',
        method: 'debate',
        requires_visible_delivery: true,
        user_visible_task: '基于后台综合结果,向用户输出独立可见的最终结论',
        original_user_message_id: '5',
        result_file: 'panel-5-shared.json',
        result_summary: 'debate 综合:暂不建议迁移,因为监管风险高。',
        delivery_contract: 'send_standalone_final_answer',
        status: 'result_ready',
      }],
    }, null, 2));
    await post('/v1/hook/precmd', { session_id: sharedFileSid, agent: 'agent-a', cwd: CWD_OFF, prompt: '继续' });
    const sharedFileAck = await post('/v1/hook/message-sent', { session_id: sharedFileSid, content: '收到 debate 后台综合结果。1. 后台裁决结论:暂不建议迁移。详见 panel-5-shared.json。' });
    const sharedFileState = JSON.parse(fs.readFileSync(path.join(ROOT, 'sessions', sharedFileSid, 'state.json'), 'utf8'));
    assert(
      sharedFileAck.delivered === 0 &&
        sharedFileAck.pending === 2 &&
        (sharedFileState.pending_deliveries || []).length === 2,
      '同 method 多条后台结果共享 result_file 时不能把文件名当作专属证据',
      JSON.stringify({ ack: sharedFileAck, pending: sharedFileState.pending_deliveries })
    );

    const sharedIdSid = 'openclaw-same-method-shared-delivery-id';
    fs.mkdirSync(path.join(ROOT, 'sessions', sharedIdSid), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'sessions', sharedIdSid, 'trace.jsonl'), '');
    fs.writeFileSync(path.join(ROOT, 'sessions', sharedIdSid, 'state.json'), JSON.stringify({
      turn: 5,
      cwd: CWD_OFF,
      host: 'openclaw',
      pending_deliveries: [{
        id: 'bg-5-debate-dup',
        source: 'supathink',
        event_type: 'background_result_ready',
        method: 'debate',
        requires_visible_delivery: true,
        user_visible_task: '基于后台综合结果,向用户输出独立可见的最终结论',
        original_user_message_id: '5',
        result_file: 'panel-5-dup-a.json',
        result_summary: 'debate 综合:需要先做风控复核。',
        delivery_contract: 'send_standalone_final_answer',
        status: 'result_ready',
      }, {
        id: 'bg-5-debate-dup',
        source: 'supathink',
        event_type: 'background_result_ready',
        method: 'debate',
        requires_visible_delivery: true,
        user_visible_task: '基于后台综合结果,向用户输出独立可见的最终结论',
        original_user_message_id: '5',
        result_file: 'panel-5-dup-b.json',
        result_summary: 'debate 综合:需要先做仓位复核。',
        delivery_contract: 'send_standalone_final_answer',
        status: 'result_ready',
      }],
    }, null, 2));
    await post('/v1/hook/precmd', { session_id: sharedIdSid, agent: 'agent-a', cwd: CWD_OFF, prompt: '继续' });
    const sharedIdAck = await post('/v1/hook/message-sent', { session_id: sharedIdSid, content: '收到 debate 后台综合结果。1. 后台裁决结论:我已处理 bg-5-debate-dup。' });
    const sharedIdState = JSON.parse(fs.readFileSync(path.join(ROOT, 'sessions', sharedIdSid, 'state.json'), 'utf8'));
    assert(
      sharedIdAck.delivered === 0 &&
        sharedIdAck.pending === 2 &&
        (sharedIdState.pending_deliveries || []).length === 2,
      '同 method 多条后台结果共享 delivery_id 时不能把 id 当作专属证据',
      JSON.stringify({ ack: sharedIdAck, pending: sharedIdState.pending_deliveries })
    );

    const panelApiSid = 'panel-api-same-turn-unique-files';
    fs.mkdirSync(path.join(ROOT, 'sessions', panelApiSid), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'sessions', panelApiSid, 'trace.jsonl'), '');
    fs.writeFileSync(path.join(ROOT, 'sessions', panelApiSid, 'state.json'), JSON.stringify({
      turn: 7,
      cwd: CWD_OFF,
      host: 'codex',
    }, null, 2));
    await post('/v1/panel', { session_id: panelApiSid, cwd: CWD_OFF, mode: 'lite', question: '同一轮第一次合议' });
    await post('/v1/panel', { session_id: panelApiSid, cwd: CWD_OFF, mode: 'lite', question: '同一轮第二次合议' });
    for (let i = 0; i < 20; i++) {
      const st = await readJsonRetry(path.join(ROOT, 'sessions', panelApiSid, 'state.json'));
      if ((st.pending_deliveries || []).length >= 2) break;
      await sleep(50);
    }
    const panelApiState = await readJsonRetry(path.join(ROOT, 'sessions', panelApiSid, 'state.json'));
    const panelApiFiles = (panelApiState.pending_deliveries || []).map((d) => d.result_file).filter(Boolean);
    assert(
      panelApiFiles.length >= 2 && new Set(panelApiFiles).size === panelApiFiles.length,
      '/v1/panel 同 turn 同 method 多次后台任务必须生成唯一 result_file',
      JSON.stringify(panelApiFiles)
    );

    const bulkSid = 'openclaw-delivery-queue-no-truncate';
    fs.mkdirSync(path.join(ROOT, 'sessions', bulkSid), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'sessions', bulkSid, 'trace.jsonl'), '');
    const bulkDeliveries = Array.from({ length: 10 }, (_, i) => ({
      id: `bg-bulk-${i}`,
      source: 'supathink',
      event_type: 'background_result_ready',
      method: 'panel',
      requires_visible_delivery: true,
      user_visible_task: '基于后台综合结果,向用户输出独立可见的最终结论',
      original_user_message_id: String(i),
      result_file: `panel-bulk-${i}.json`,
      result_summary: `panel 综合:批量结果 ${i}`,
      delivery_contract: 'send_standalone_final_answer',
      status: 'result_ready',
    }));
    fs.writeFileSync(path.join(ROOT, 'sessions', bulkSid, 'state.json'), JSON.stringify({
      turn: 9,
      cwd: CWD_OFF,
      host: 'openclaw',
      pending_deliveries: bulkDeliveries,
    }, null, 2));
    await post('/v1/hook/precmd', { session_id: bulkSid, agent: 'agent-a', cwd: CWD_OFF, prompt: '继续' });
    const bulkAck = await post('/v1/hook/message-sent', {
      session_id: bulkSid,
      content: '收到 panel 后台综合结果。1. 后台裁决结论:批量结果 0。详见 panel-bulk-0.json。',
    });
    const bulkState = JSON.parse(fs.readFileSync(path.join(ROOT, 'sessions', bulkSid, 'state.json'), 'utf8'));
    assert(
      bulkAck.delivered === 1 &&
        bulkAck.attempted === 10 &&
        bulkAck.pending === 9 &&
        (bulkState.pending_deliveries || []).length === 9,
      '强交付队列超过 8 条时未交付项不能被截断丢失',
      JSON.stringify({ ack: bulkAck, pending: (bulkState.pending_deliveries || []).length })
    );

    const legacyNearDuplicateSid = 'openclaw-legacy-near-duplicate-delivery';
    fs.mkdirSync(path.join(ROOT, 'sessions', legacyNearDuplicateSid), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'sessions', legacyNearDuplicateSid, 'trace.jsonl'), '');
    fs.writeFileSync(path.join(ROOT, 'sessions', legacyNearDuplicateSid, 'state.json'), JSON.stringify({
      turn: 4,
      cwd: CWD_OFF,
      host: 'openclaw',
      pending_findings: [
        '【debate 综合(全文见 supathink log / panel-4-a.json)】建议暂缓。',
        '【debate 综合(全文见 supathink log / panel-4-b.json)】建议暂缓,但如有回滚窗口可小步试。',
      ],
    }, null, 2));
    const legacyNearDuplicate = await post('/v1/hook/precmd', { session_id: legacyNearDuplicateSid, agent: 'agent-a', cwd: CWD_OFF, prompt: '继续' });
    const legacyNearDuplicateState = JSON.parse(fs.readFileSync(path.join(ROOT, 'sessions', legacyNearDuplicateSid, 'state.json'), 'utf8'));
    assert(
      legacyNearDuplicate.requiresVisibleDelivery === true &&
        (legacyNearDuplicateState.pending_delivery_inflight || []).length === 2,
      'legacy 相似但非完全相同的后台结果不能被包含关系去重吞掉',
      JSON.stringify((legacyNearDuplicateState.pending_delivery_inflight || []).map((d) => d.result_summary))
    );

    const legacyLongPrefixSid = 'openclaw-legacy-long-prefix-delivery';
    fs.mkdirSync(path.join(ROOT, 'sessions', legacyLongPrefixSid), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'sessions', legacyLongPrefixSid, 'trace.jsonl'), '');
    const sharedPrefix = '共同长前缀'.repeat(160);
    fs.writeFileSync(path.join(ROOT, 'sessions', legacyLongPrefixSid, 'state.json'), JSON.stringify({
      turn: 4,
      cwd: CWD_OFF,
      host: 'openclaw',
      pending_findings: [
        `【debate 综合(全文见 supathink log / panel-4-a.json)】${sharedPrefix}结论A:建议暂缓。`,
        `【debate 综合(全文见 supathink log / panel-4-b.json)】${sharedPrefix}结论B:可小步试。`,
      ],
    }, null, 2));
    await post('/v1/hook/precmd', { session_id: legacyLongPrefixSid, agent: 'agent-a', cwd: CWD_OFF, prompt: '继续' });
    const legacyLongPrefixState = JSON.parse(fs.readFileSync(path.join(ROOT, 'sessions', legacyLongPrefixSid, 'state.json'), 'utf8'));
    assert(
      (legacyLongPrefixState.pending_delivery_inflight || []).length === 2,
      'legacy 长共同前缀但尾部不同的后台结果不能因归一化截断被去重吞掉',
      JSON.stringify((legacyLongPrefixState.pending_delivery_inflight || []).map((d) => d.result_summary.slice(-40)))
    );

    const panelFamilySid = 'openclaw-panel-family-method-match';
    fs.mkdirSync(path.join(ROOT, 'sessions', panelFamilySid), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'sessions', panelFamilySid, 'trace.jsonl'), '');
    fs.writeFileSync(path.join(ROOT, 'sessions', panelFamilySid, 'state.json'), JSON.stringify({
      turn: 5,
      cwd: CWD_OFF,
      host: 'openclaw',
      pending_deliveries: [{
        id: 'bg-5-panel',
        source: 'supathink',
        event_type: 'background_result_ready',
        method: 'panel',
        requires_visible_delivery: true,
        user_visible_task: '基于后台综合结果,向用户输出独立可见的最终结论',
        original_user_message_id: '5',
        result_file: 'panel-5.json',
        result_summary: 'panel 综合:建议暂停。',
        delivery_contract: 'send_standalone_final_answer',
        status: 'result_ready',
      }, {
        id: 'bg-5-panel-lite',
        source: 'supathink',
        event_type: 'background_result_ready',
        method: 'panel-lite',
        requires_visible_delivery: true,
        user_visible_task: '基于后台综合结果,向用户输出独立可见的最终结论',
        original_user_message_id: '5',
        result_file: 'panel-5-lite.json',
        result_summary: 'panel-lite 综合:可以先做小实验。',
        delivery_contract: 'send_standalone_final_answer',
        status: 'result_ready',
      }],
    }, null, 2));
    await post('/v1/hook/precmd', { session_id: panelFamilySid, agent: 'agent-a', cwd: CWD_OFF, prompt: '继续' });
    const panelFamilyAck = await post('/v1/hook/message-sent', { session_id: panelFamilySid, content: '收到 panel-lite 后台综合结果。1. 后台裁决结论:可以先做小实验。这个合议结果来自单模型三视角。' });
    const panelFamilyState = JSON.parse(fs.readFileSync(path.join(ROOT, 'sessions', panelFamilySid, 'state.json'), 'utf8'));
    assert(
      panelFamilyAck.delivered === 1 && panelFamilyAck.pending === 1 && (panelFamilyState.pending_deliveries || []).some((d) => d.method === 'panel'),
      'panel-lite 交付不能误标 panel 已交付',
      JSON.stringify({ ack: panelFamilyAck, pending: panelFamilyState.pending_deliveries })
    );

    const redblueSid = 'openclaw-redblue-delivery-method-match';
    fs.mkdirSync(path.join(ROOT, 'sessions', redblueSid), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'sessions', redblueSid, 'trace.jsonl'), '');
    fs.writeFileSync(path.join(ROOT, 'sessions', redblueSid, 'state.json'), JSON.stringify({
      turn: 5,
      cwd: CWD_OFF,
      host: 'openclaw',
      pending_deliveries: [{
        id: 'bg-5-redblue',
        source: 'supathink',
        event_type: 'background_result_ready',
        method: 'redblue',
        requires_visible_delivery: true,
        user_visible_task: '基于后台综合结果,向用户输出独立可见的最终结论',
        original_user_message_id: '5',
        result_file: 'panel-5-redblue.json',
        result_summary: 'redblue 综合:蓝案可行但红攻指出回滚窗口不足。',
        delivery_contract: 'send_standalone_final_answer',
        status: 'result_ready',
      }],
    }, null, 2));
    await post('/v1/hook/precmd', { session_id: redblueSid, agent: 'agent-a', cwd: CWD_OFF, prompt: '继续' });
    const redblueAck = await post('/v1/hook/message-sent', { session_id: redblueSid, content: '收到 redblue 后台综合结果。1. 后台裁决结论:蓝案可行,但需要补回滚窗口。' });
    assert(redblueAck.delivered === 1 && redblueAck.pending === 0, 'redblue 展示名不能破坏交付契约匹配', JSON.stringify(redblueAck));

    const falsePositiveSid = 'openclaw-delivery-false-positive';
    fs.mkdirSync(path.join(ROOT, 'sessions', falsePositiveSid), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'sessions', falsePositiveSid, 'trace.jsonl'), '');
    fs.writeFileSync(path.join(ROOT, 'sessions', falsePositiveSid, 'state.json'), JSON.stringify({
      turn: 6,
      cwd: CWD_OFF,
      host: 'openclaw',
      pending_deliveries: [{
        id: 'bg-6-altitude',
        source: 'supathink',
        event_type: 'background_result_ready',
        method: 'altitude',
        requires_visible_delivery: true,
        user_visible_task: '基于后台结果,向用户输出独立可见的最终结论',
        original_user_message_id: '6',
        result_file: 'trace.jsonl',
        result_summary: 'Navigator 七轴:需要重新确认目标。',
        delivery_contract: 'send_standalone_final_answer',
        status: 'result_ready',
      }],
    }, null, 2));
    await post('/v1/hook/precmd', { session_id: falsePositiveSid, agent: 'agent-a', cwd: CWD_OFF, prompt: '继续' });
    const falsePositiveAck = await post('/v1/hook/message-sent', { session_id: falsePositiveSid, content: '好的,收到。为了确保团队对齐,最终更新后的结论:先等一下。' });
    assert(falsePositiveAck.delivered === 0 && falsePositiveAck.pending === 1, '泛泛提到对齐/最终结论不能伪满足 altitude 交付契约', JSON.stringify(falsePositiveAck));

    const mixedLegacySid = 'openclaw-mixed-structured-legacy-delivery';
    fs.mkdirSync(path.join(ROOT, 'sessions', mixedLegacySid), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'sessions', mixedLegacySid, 'trace.jsonl'), '');
    fs.writeFileSync(path.join(ROOT, 'sessions', mixedLegacySid, 'state.json'), JSON.stringify({
      turn: 4,
      cwd: CWD_OFF,
      host: 'openclaw',
      pending_deliveries: [{
        id: 'bg-4-panel',
        source: 'supathink',
        event_type: 'background_result_ready',
        method: 'panel',
        requires_visible_delivery: true,
        user_visible_task: '基于后台综合结果,向用户输出独立可见的最终结论',
        original_user_message_id: '4',
        result_file: 'panel-4.json',
        result_summary: 'panel 综合:建议先试点。',
        delivery_contract: 'send_standalone_final_answer',
        status: 'result_ready',
      }],
      pending_findings: ['【Judge 裁决(MiniMax-M3)】双方分歧在风险承受能力;建议先降仓位再观察。'],
    }, null, 2));
    const mixedLegacy = await post('/v1/hook/precmd', { session_id: mixedLegacySid, agent: 'agent-a', cwd: CWD_OFF, prompt: '继续' });
    const mixedLegacyCtx = mixedLegacy.additionalContext || '';
    const mixedLegacyState = JSON.parse(fs.readFileSync(path.join(ROOT, 'sessions', mixedLegacySid, 'state.json'), 'utf8'));
    assert(
      mixedLegacy.requiresVisibleDelivery === true &&
        mixedLegacyCtx.includes('method: panel') &&
        mixedLegacyCtx.includes('method: judge') &&
        (mixedLegacyState.pending_delivery_inflight || []).length === 2,
      '结构化 delivery 与不同 legacy finding 并存时不能丢失旧后台结果',
      mixedLegacyCtx
    );

    const judgeSid = 'openclaw-judge-legacy-delivery';
    fs.mkdirSync(path.join(ROOT, 'sessions', judgeSid), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'sessions', judgeSid, 'trace.jsonl'), '');
    fs.writeFileSync(path.join(ROOT, 'sessions', judgeSid, 'state.json'), JSON.stringify({
      turn: 4,
      cwd: CWD_OFF,
      host: 'openclaw',
      pending_findings: ['【Judge 裁决(MiniMax-M3)】双方分歧在风险承受能力;建议先降仓位再观察。'],
    }, null, 2));
    const judgeDelivery = await post('/v1/hook/precmd', { session_id: judgeSid, agent: 'agent-a', cwd: CWD_OFF, prompt: '继续' });
    const judgeCtx = judgeDelivery.additionalContext || '';
    assert(judgeDelivery.requiresVisibleDelivery === true && judgeCtx.includes('method: judge') && judgeCtx.includes('后台结果已完成'), '旧 Judge/未决分歧 pending 也升级为强交付事件', judgeCtx);

    const legacyLiteSid = 'openclaw-lite-legacy-delivery';
    fs.mkdirSync(path.join(ROOT, 'sessions', legacyLiteSid), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'sessions', legacyLiteSid, 'trace.jsonl'), '');
    fs.writeFileSync(path.join(ROOT, 'sessions', legacyLiteSid, 'state.json'), JSON.stringify({
      turn: 4,
      cwd: CWD_OFF,
      host: 'openclaw',
      pending_findings: ['【lite 综合(全文见 supathink log / panel-4.json)】三视角建议先做小实验。'],
    }, null, 2));
    const legacyLiteDelivery = await post('/v1/hook/precmd', { session_id: legacyLiteSid, agent: 'agent-a', cwd: CWD_OFF, prompt: '继续' });
    const legacyLiteCtx = legacyLiteDelivery.additionalContext || '';
    assert(legacyLiteDelivery.requiresVisibleDelivery === true && legacyLiteCtx.includes('method: panel-lite'), '旧 lite pending 应升级为 panel-lite 强交付事件', legacyLiteCtx);

    const legacyFailSid = 'openclaw-panel-failed-legacy-delivery';
    fs.mkdirSync(path.join(ROOT, 'sessions', legacyFailSid), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'sessions', legacyFailSid, 'trace.jsonl'), '');
    fs.writeFileSync(path.join(ROOT, 'sessions', legacyFailSid, 'state.json'), JSON.stringify({
      turn: 4,
      cwd: CWD_OFF,
      host: 'openclaw',
      pending_findings: ['【panel】未能成组:API 超时'],
    }, null, 2));
    const legacyFailDelivery = await post('/v1/hook/precmd', { session_id: legacyFailSid, agent: 'agent-a', cwd: CWD_OFF, prompt: '继续' });
    const legacyFailCtx = legacyFailDelivery.additionalContext || '';
    assert(
      legacyFailDelivery.requiresVisibleDelivery === true &&
        legacyFailCtx.includes('event_type: background_result_failed') &&
        legacyFailCtx.includes('后台执行结果'),
      '旧 panel 失败 pending 应使用失败强交付模板',
      legacyFailCtx
    );

    const legacyRedblueSid = 'openclaw-redblue-display-legacy-delivery';
    fs.mkdirSync(path.join(ROOT, 'sessions', legacyRedblueSid), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'sessions', legacyRedblueSid, 'trace.jsonl'), '');
    fs.writeFileSync(path.join(ROOT, 'sessions', legacyRedblueSid, 'state.json'), JSON.stringify({
      turn: 4,
      cwd: CWD_OFF,
      host: 'openclaw',
      pending_findings: ['【redblue(蓝案红攻) 综合(全文见 supathink log / panel-4.json)】红方残余风险仍高。'],
    }, null, 2));
    const legacyRedblueDelivery = await post('/v1/hook/precmd', { session_id: legacyRedblueSid, agent: 'agent-a', cwd: CWD_OFF, prompt: '继续' });
    const legacyRedblueCtx = legacyRedblueDelivery.additionalContext || '';
    assert(legacyRedblueDelivery.requiresVisibleDelivery === true && legacyRedblueCtx.includes('method: redblue'), '旧 redblue 展示名 pending 应升级为 redblue 强交付事件', legacyRedblueCtx);

    const ccDeliverySid = 'cc-default-off-pending-delivery';
    fs.mkdirSync(path.join(ROOT, 'sessions', ccDeliverySid), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'sessions', ccDeliverySid, 'trace.jsonl'), '');
    fs.writeFileSync(path.join(ROOT, 'sessions', ccDeliverySid, 'state.json'), JSON.stringify({
      turn: 2,
      cwd: CWD_OFF,
      last_mode: 'off',
      pending_deliveries: [{
        id: 'bg-2-panel',
        source: 'supathink',
        event_type: 'background_result_ready',
        method: 'panel',
        requires_visible_delivery: true,
        user_visible_task: '基于后台综合结果,向用户输出独立可见的最终结论',
        original_user_message_id: '2',
        result_file: 'panel-2.json',
        result_summary: 'panel 综合:建议先做小规模试点。',
        delivery_contract: 'send_standalone_final_answer',
        status: 'result_ready',
      }],
    }, null, 2));
    const ccDelivery = await post('/v1/hook/user-prompt', { session_id: ccDeliverySid, cwd: CWD_OFF, prompt: '继续' });
    const ccDeliveryCtx = (ccDelivery.hookSpecificOutput || {}).additionalContext || '';
    await post('/v1/hook/stop', { session_id: ccDeliverySid, cwd: CWD_OFF, stop_hook_active: false, last_assistant_message: '收到 panel 后台综合结果。\n1. 后台裁决结论:建议先做小规模试点。' });
    const ccDeliveryTrace = fs.readFileSync(path.join(ROOT, 'sessions', ccDeliverySid, 'trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert(
      ccDeliveryCtx.includes('后台结果已完成') &&
        ccDeliveryTrace.some((e) => e.type === 'background_result_delivery_requested') &&
        ccDeliveryTrace.some((e) => e.type === 'background_result_delivered'),
      'CC/Codex 默认 off 仍交付显式后台结果并落 delivered',
      ccDeliveryTrace.map((e) => e.type).join(',')
    );

    const ccBadDeliverySid = 'cc-stop-requeues-bad-delivery';
    fs.mkdirSync(path.join(ROOT, 'sessions', ccBadDeliverySid), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'sessions', ccBadDeliverySid, 'trace.jsonl'), '');
    fs.writeFileSync(path.join(ROOT, 'sessions', ccBadDeliverySid, 'state.json'), JSON.stringify({
      turn: 3,
      cwd: CWD_OFF,
      last_mode: 'off',
      pending_delivery_inflight: [{
        id: 'bg-3-debate',
        source: 'supathink',
        event_type: 'background_result_ready',
        method: 'debate',
        requires_visible_delivery: true,
        user_visible_task: '基于后台综合结果,向用户输出独立可见的最终结论',
        original_user_message_id: '3',
        result_file: 'panel-3.json',
        result_summary: 'debate 综合:建议暂缓。',
        delivery_contract: 'send_standalone_final_answer',
        status: 'delivery_requested',
      }],
    }, null, 2));
    await post('/v1/hook/stop', { session_id: ccBadDeliverySid, cwd: CWD_OFF, stop_hook_active: false, last_assistant_message: '这只是普通回复,没按后台模板交付。' });
    const ccBadState = JSON.parse(fs.readFileSync(path.join(ROOT, 'sessions', ccBadDeliverySid, 'state.json'), 'utf8'));
    const ccBadTrace = fs.readFileSync(path.join(ROOT, 'sessions', ccBadDeliverySid, 'trace.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert(
      (ccBadState.pending_deliveries || []).length === 1 &&
        ccBadTrace.some((e) => e.type === 'background_result_delivery_attempted' && e.contract_satisfied === false),
      'CC/Codex Stop 未满足后台交付契约时重新排队',
      JSON.stringify({ pending: ccBadState.pending_deliveries || [], trace: ccBadTrace.map((e) => e.type) })
    );

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
          : (prompt.includes('这个事实是错的')
              ? '{"claims":[{"id":"c1","type":"fact","text":"这个事实是错的","verifiable":true,"check":"fetch","verdict":"refuted"}],"annotations":[],"checked_categories":["fact"],"verdict":"block","reason":"refuted claim only"}'
              : '{}');
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
      const blockSid = 'cc-block-preserves-pending-delivery';
      fs.mkdirSync(path.join(ROOT, 'sessions', blockSid), { recursive: true });
      fs.writeFileSync(path.join(ROOT, 'sessions', blockSid, 'trace.jsonl'), '');
      fs.writeFileSync(path.join(ROOT, 'sessions', blockSid, 'state.json'), JSON.stringify({
        turn: 8,
        cwd: CWD_OFF,
        last_mode: 'full',
        last_prompt: '是否继续这个发布目标?',
        pending_deliveries: [{
          id: 'bg-8-debate',
          source: 'supathink',
          event_type: 'background_result_ready',
          method: 'debate',
          requires_visible_delivery: true,
          user_visible_task: '基于后台综合结果,向用户输出独立可见的最终结论',
          original_user_message_id: '8',
          result_file: 'panel-8.json',
          result_summary: 'debate 综合:先暂停发布。',
          delivery_contract: 'send_standalone_final_answer',
          status: 'result_ready',
        }],
      }, null, 2));
      const blockRes = await post('/v1/hook/stop', {
        session_id: blockSid,
        cwd: CWD_OFF,
        stop_hook_active: false,
        last_assistant_message: '本轮采用 决策矩阵。继续发布。',
      });
      const blockState = JSON.parse(fs.readFileSync(path.join(ROOT, 'sessions', blockSid, 'state.json'), 'utf8'));
      assert(
        blockRes.decision === 'block' &&
          (blockState.pending_deliveries || []).some((d) => d.id === 'bg-8-debate') &&
          blockState.last_severe && blockState.last_severe.length,
        'full 审稿 block 保存状态时不覆盖已有 pending_deliveries',
        JSON.stringify({ decision: blockRes.decision, pending: blockState.pending_deliveries || [], severe: blockState.last_severe || [] })
      );

      const ocRefutedSid = 'openclaw-review-refuted-claim-revise';
      fs.mkdirSync(path.join(ROOT, 'sessions', ocRefutedSid), { recursive: true });
      fs.writeFileSync(path.join(ROOT, 'sessions', ocRefutedSid, 'trace.jsonl'), '');
      fs.writeFileSync(path.join(ROOT, 'sessions', ocRefutedSid, 'state.json'), JSON.stringify({
        turn: 4,
        cwd: CWD_OFF,
        host: 'openclaw',
        session_auto: true,
      }, null, 2));
      const ocRefuted = await post('/v1/review', {
        session_id: ocRefutedSid,
        cwd: CWD_OFF,
        agent: 'agent-a',
        transport: 'openclaw-plugin',
        mode: 'full',
        prompt: '核验这个事实',
        draft: '这个事实是错的。',
      });
      const ocRefutedTrace = fs.readFileSync(path.join(ROOT, 'sessions', ocRefutedSid, 'trace.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      assert(
        ocRefuted.verdict === 'revise' &&
          String(ocRefuted.instruction || '').includes('核验否定') &&
          ocRefutedTrace.some((e) => e.type === 'verification_result' && e.verdict === 'refuted'),
        'OpenClaw /v1/review 将 refuted claim 升级为 revise 并记录 verification_result',
        JSON.stringify({ verdict: ocRefuted.verdict, instruction: ocRefuted.instruction, trace: ocRefutedTrace.map((e) => `${e.type}:${e.verdict || ''}`) })
      );

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
