#!/usr/bin/env node
'use strict';
// supathink daemon(Phase 1,§9.1/§9.3):只绑 127.0.0.1:7777,一个 daemon 服务多会话(按 session_id 区分)
// 铁律(§3.4):daemon 任何故障 → hook 非 2xx/超时 = 宿主非阻塞错误 → 静默退化为原生宿主
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { route } = require(path.join(__dirname, '..', 'lib', 'router'));
const { renderMenu, pickMenu } = require(path.join(__dirname, '..', 'lib', 'menu'));
const { appendTrace, loadState, saveState, sessionStateExists, ROOT } = require(path.join(__dirname, '..', 'lib', 'trace'));
const { loadConfig, detectForce, detectSlowFull, detectSessionToggle, detectPanel, detectAltitude, detectWin, detectHelp, ST_COMMANDS } = require(path.join(__dirname, '..', 'lib', 'config'));
const { fastCheck, slowVerify, fullReview } = require('./critics');
const navigator = require('./navigator');
const cacheLib = require('./claims-cache');
const { ping } = require('./deepseek');
const ledgerLib = require('./ledger');
const { runPanel, runPanelLite, runDebate, runDelphi, runRedBlue } = require('./panel');
const capsLib = require('./capabilities');
const { resolveEngine } = require('./engines');
const pbLib = require('./playbooks');

const PORT = Number(process.env.SUPATHINK_PORT || 7777);
const LOG = path.join(ROOT, 'daemon.log');
const PROTOCOL_FOOTER = '请按超限思考协议第 3 条逐条回应:采纳(修改)/ 驳回(给出具体理由)/ 待查;修订后在答案末尾保留「── 核验 ──」脚注(✓ 已证实 / ✗ 已修正 / △ 未决 + 置信)。';
const STANCE_TIP = {
  mirror: '镜子——先接住情绪,多提问少给方案,除非对方明确要解法',
  mentor: '导师——苏格拉底式,讲原理教方法,给对方留思考台阶',
  strategist: '军师——给选项+推荐+理由,明确「但你定」,不代拍板',
  secretary: '秘书——确认范围后利落执行,少发散',
};

function dlog(msg) {
  try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`); } catch (_) {}
}
function quota(entry) {
  try { fs.appendFileSync(path.join(ROOT, 'quota.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'); } catch (_) {}
}
function statusFile(sessionId, text) {
  try {
    const f = path.join(ROOT, 'sessions', String(sessionId), 'status.txt');
    if (text) fs.writeFileSync(f, text); else fs.rmSync(f, { force: true });
  } catch (_) {}
}
function isDisabled() {
  try { return fs.existsSync(path.join(ROOT, 'DISABLED')); } catch (_) { return false; }
}
function disabledResponse(url) {
  if (url === '/v1/review') return { mode: 'off', verdict: 'pass', skipped: 'disabled' };
  if (url === '/v1/panel') return { error: 'supathink disabled' };
  return {};
}
// Critic 子会话防递归:HTTP hook 下环境变量不可达,以工作目录识别(critic-work 由本系统指定)
function isCriticSession(payload) {
  return String(payload.cwd || '').includes(`${path.sep}.supathink${path.sep}critic-work`);
}
// 宿主指纹(实测):Codex payload 带 model 字段且 transcript 为 rollout-*.jsonl;CC 无 model 字段
function detectHost(payload) {
  if (payload.model || /rollout-.*\.jsonl$/.test(String(payload.transcript_path || ''))) return 'codex';
  return 'claude-code';
}
function draftFrom(payload) {
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
        } catch (_) {}
      }
    } catch (_) {}
  }
  return draft;
}

function launchPanelAsync(sid, turn, question, panelMode, cfg) {
  setImmediate(async () => {
    const resultFile = makePanelResultFile(turn, panelMode, question);
    try {
      const RUNNERS = { lite: runPanelLite, panel: runPanel, debate: runDebate, delphi: runDelphi, redblue: runRedBlue };
      if (!RUNNERS[panelMode]) {
        const s2 = loadState(sid);
        const delivery = makeBackgroundEventDelivery(turn, panelMode || 'panel', question, `后台合议未知模式:${panelMode}`, 'daemon.log', true);
        s2.pending_findings = (s2.pending_findings || []).concat([`【panel】未能成组:未知模式:${panelMode}`]);
        appendPendingDeliveries(s2, [delivery]);
        saveState(sid, s2);
        traceBackgroundReady(sid, turn, delivery);
        statusFile(sid, `⚠ supathink:${delivery.method} 结果待交付`);
        return;
      }
      const r = await RUNNERS[panelMode](question, cfg);
      for (const u of (r.usage || []).filter(Boolean)) quota({ session_id: sid, turn, event: `panel_${panelMode}`, usage: u });
      const dir = path.join(ROOT, 'sessions', String(sid));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, resultFile), JSON.stringify(r, null, 2));
      const s2 = loadState(sid);
      const delivery = makeBackgroundDelivery(turn, question, panelMode, r, resultFile);
      if (r.error) {
        const msg = `【${normalizeBackgroundMethod(panelMode || r.mode || 'panel')}】未能成组:${r.error}${r.absent && r.absent.length ? ';缺席:' + r.absent.join(' / ') : ''}`;
        s2.pending_findings = (s2.pending_findings || []).concat([msg]);
      } else {
        s2.pending_findings = (s2.pending_findings || []).concat([`【${r.mode} 综合(全文见 supathink log / ${resultFile})】\n${String(r.synthesis).slice(0, 800)}`]);
      }
      appendPendingDeliveries(s2, [delivery]);
      s2.last_recipe = { mode: 'panel', intent: null, triggers: [`panel_${panelMode}`], panel: true, panel_type: panelMode }; // §11 配方素材
      saveState(sid, s2);
      appendTrace(sid, {
        turn,
        type: 'background_result_ready',
        delivery_id: delivery.id,
        event_type: delivery.event_type,
        method: delivery.method,
        result_file: delivery.result_file,
        summary_chars: delivery.result_summary.length,
      });
      statusFile(sid, `⚠ supathink:${delivery.method} 结果待交付`);
    } catch (e) {
      dlog(`panel error: ${e.message}`);
      try {
        const delivery = makeBackgroundEventDelivery(turn, panelMode || 'panel', question, `${panelDisplayName(panelMode)} 后台未能完成:${e.message}`, 'daemon.log', true);
        const s2 = loadState(sid);
        s2.pending_findings = (s2.pending_findings || []).concat([`【${normalizeBackgroundMethod(panelMode || 'panel')}】未能成组:${e.message}`]);
        appendPendingDeliveries(s2, [delivery]);
        saveState(sid, s2);
        traceBackgroundReady(sid, turn, delivery);
        statusFile(sid, `⚠ supathink:${delivery.method} 结果待交付`);
      } catch (e2) {
        dlog(`panel failure delivery error: ${e2.message}`);
      }
    }
  });
}

// 手动/auto 已开启时的升档入口:消费 cwd 域升档文件(10 分钟内有效,一次性)。
function consumeEscalation(cwd) {
  try {
    const slug = String(cwd || '').replace(/[\/\\]/g, '-').replace(/^-+/, '') || 'unknown';
    const f = path.join(ROOT, 'escalations', slug + '.json');
    const e = JSON.parse(fs.readFileSync(f, 'utf8'));
    fs.rmSync(f, { force: true });
    if (Date.now() - (e.ts || 0) > 600_000) return null;
    return e;
  } catch (_) { return null; }
}

function updateGoalTracking(state, prompt) {
  const wasConfirmed = !!(state.ledger && state.ledger.terminal_goal && state.ledger.terminal_goal.confirmed);
  state.ledger = ledgerLib.update(state.ledger, prompt);
  state.active_turns = (state.active_turns || 0) + 1;
  const nowConfirmed = !!(state.ledger.terminal_goal && state.ledger.terminal_goal.confirmed);
  state.turns_since_goal_confirm = (!wasConfirmed && nowConfirmed) ? 0 : (state.turns_since_goal_confirm || 0) + 1;
}

function goalStale(state) {
  return !!(state
    && (state.turns_since_goal_confirm || 0) >= 5
    && !(state.ledger && state.ledger.terminal_goal && state.ledger.terminal_goal.confirmed));
}

function normalizeBackgroundMethod(mode, fallback = 'panel') {
  const m = String(mode || fallback);
  if (m === 'lite') return 'panel-lite';
  if (m.startsWith('redblue')) return 'redblue';
  return m;
}

function panelDisplayName(mode) {
  const m = normalizeBackgroundMethod(mode);
  if (m === 'redblue') return 'redblue(蓝案红攻)';
  return m;
}

function appendPendingDeliveries(state, deliveries) {
  const existing = Array.isArray(state.pending_deliveries) ? state.pending_deliveries : [];
  state.pending_deliveries = existing.concat(deliveries || []);
}

function makePanelResultFile(turn, panelMode, question) {
  const method = normalizeBackgroundMethod(panelMode || 'panel', 'panel');
  const methodPart = String(method).replace(/[^a-z0-9-]/gi, '-');
  const hash = crypto.createHash('sha1')
    .update(`${Date.now()}\n${process.hrtime.bigint()}\n${method}\n${question || ''}\n${crypto.randomBytes(4).toString('hex')}`)
    .digest('hex')
    .slice(0, 8);
  return `panel-${turn}-${methodPart}-${hash}.json`;
}

function stripPanelQuestion(prompt) {
  return String(prompt || '')
    .replace(/^\s*\/st[:\/-]?panel-?lite\b/, '')
    .replace(/^\s*\/st[:\/-]?(panel|debate|delphi|redblue)\b/, '')
    .replace(/^\s*SUPATHINK_PANEL=(panel-?lite|panel|lite|debate|delphi|redblue)\b/, '')
    .trim();
}

function stripAltitudeQuestion(prompt) {
  return String(prompt || '')
    .replace(/^\s*\/st[:\/-]?altitude\b/, '')
    .replace(/^\s*SUPATHINK_ALTITUDE=1\b/, '')
    .trim();
}

function makeBackgroundDelivery(turn, question, requestedMode, result, resultFile) {
  const mode = normalizeBackgroundMethod((result && result.mode) || requestedMode);
  const failed = !!(result && result.error);
  const resultSummary = failed
    ? `未能完成:${result.error}${result.absent && result.absent.length ? ';缺席:' + result.absent.join(' / ') : ''}`
    : String((result && result.synthesis) || '').slice(0, 1200);
  const fileName = resultFile || `panel-${turn}.json`;
  const idHash = crypto.createHash('sha1').update(`${mode}\n${question || ''}\n${resultSummary}\n${fileName}`).digest('hex').slice(0, 8);
  return {
    id: `bg-${turn}-${String(mode).replace(/[^a-z0-9-]/gi, '-')}-${idHash}`,
    source: 'supathink',
    event_type: failed ? 'background_result_failed' : 'background_result_ready',
    method: mode,
    requires_visible_delivery: true,
    user_visible_task: failed
      ? '向用户独立说明后台合议未能完成,不要伪造综合结论'
      : '基于后台综合结果,向用户输出独立可见的最终结论',
    original_user_message_id: String(turn),
    original_topic: String(question || '').slice(0, 200),
    result_file: fileName,
    result_summary: resultSummary,
    dedupe_summary: resultSummary,
    delivery_contract: 'send_standalone_final_answer',
    status: 'result_ready',
    created_at: new Date().toISOString(),
  };
}

function makeBackgroundEventDelivery(turn, method, topic, summary, resultFile, failed) {
  const normalizedMethod = normalizeBackgroundMethod(method || 'background', 'background');
  return {
    id: `bg-${turn}-${String(normalizedMethod || 'event').replace(/[^a-z0-9-]/gi, '-')}-${crypto.createHash('sha1').update(String(summary || '')).digest('hex').slice(0, 8)}`,
    source: 'supathink',
    event_type: failed ? 'background_result_failed' : 'background_result_ready',
    method: normalizedMethod,
    requires_visible_delivery: true,
    user_visible_task: failed
      ? '向用户独立说明后台任务未能完成,不要伪造结论'
      : '基于后台结果,向用户输出独立可见的最终结论',
    original_user_message_id: String(turn),
    original_topic: String(topic || '').slice(0, 200),
    result_file: resultFile || 'trace.jsonl',
    result_summary: String(summary || '').slice(0, 1200),
    dedupe_summary: String(summary || ''),
    delivery_contract: 'send_standalone_final_answer',
    status: 'result_ready',
    created_at: new Date().toISOString(),
  };
}

function traceBackgroundReady(sid, turn, delivery) {
  appendTrace(sid, {
    turn,
    type: 'background_result_ready',
    delivery_id: delivery.id,
    event_type: delivery.event_type,
    method: delivery.method,
    result_file: delivery.result_file,
    summary_chars: delivery.result_summary.length,
  });
}

function isBackgroundFinding(text) {
  return /^【(?:panel|panel-lite|debate|delphi|redblue(?:\(蓝案红攻\))?|lite) 综合/.test(String(text || ''))
    || /^【(?:panel|panel-lite|debate|delphi|redblue(?:\(蓝案红攻\))?|lite)】未能成组/.test(String(text || ''))
    || /^【Judge 裁决/.test(String(text || ''))
    || /^【未决分歧】/.test(String(text || ''));
}

function legacyDeliveryFromFinding(text, turn) {
  const raw = String(text || '');
  let method = 'background';
  const failedMatch = raw.match(/^【([^】]+)】未能成组/);
  const failed = !!failedMatch;
  if (failedMatch) method = failedMatch[1];
  else if (/^【Judge 裁决/.test(raw)) method = 'judge';
  else if (/^【未决分歧】/.test(raw)) method = 'unresolved-disagreement';
  else if (/^【debate 综合/.test(raw)) method = 'debate';
  else if (/^【delphi 综合/.test(raw)) method = 'delphi';
  else if (/^【redblue(?:\(蓝案红攻\))? 综合/.test(raw)) method = 'redblue';
  else if (/^【(?:panel-lite|lite) 综合/.test(raw)) method = 'panel-lite';
  else if (/^【panel/.test(raw)) method = 'panel';
  method = normalizeBackgroundMethod(method, 'background');
  return {
    id: `legacy-bg-${turn}-${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8)}`,
    source: 'supathink',
    event_type: failed ? 'background_result_failed' : 'background_result_ready',
    method,
    requires_visible_delivery: true,
    user_visible_task: failed ? '向用户独立说明后台合议未能完成,不要伪造综合结论' : '基于后台综合结果,向用户输出独立可见的最终结论',
    original_user_message_id: String(turn || 0),
    original_topic: '(旧版本未记录议题)',
    result_file: 'trace.jsonl',
    result_summary: raw.slice(0, 1200),
    dedupe_summary: raw,
    delivery_contract: 'send_standalone_final_answer',
    status: 'result_ready',
    created_at: new Date().toISOString(),
  };
}

function normalizeDeliverySummaryText(text, maxLen = null) {
  const normalized = String(text || '')
    .replace(/^【[^】]+】/, '')
    .replace(/^(?:未能成组|未能完成|后台未能完成)[:：]?/, '')
    .replace(/\s+/g, '')
    .replace(/[.,;:!?，。；：！？、"'“”‘’()[\]（）《》<>]/g, '')
    .toLowerCase();
  return maxLen ? normalized.slice(0, maxLen) : normalized;
}

function sameBackgroundDelivery(a, b) {
  const am = normalizeBackgroundMethod(a && a.method, 'background');
  const bm = normalizeBackgroundMethod(b && b.method, 'background');
  if (am !== bm || am === 'background') return false;
  const as = normalizeDeliverySummaryText((a && (a.dedupe_summary || a.result_summary)) || '');
  const bs = normalizeDeliverySummaryText((b && (b.dedupe_summary || b.result_summary)) || '');
  return !!(as && bs && as === bs);
}

function renderBackgroundDelivery(delivery) {
  const label = panelDisplayName(delivery.method);
  const summary = String(delivery.result_summary || '').trim() || '(后台结果为空,请如实说明未取得有效综合文本)';
  const failed = delivery.event_type === 'background_result_failed';
  const template = failed
    ? [
        `收到 ${label} 后台执行状态。`,
        '1. 后台执行结果: ...',
        '2. 未完成原因: ...',
        '3. 目前不能得出的结论: ...',
        '4. 建议用户下一步怎么处理: ...',
      ]
    : [
        `收到 ${label} 后台综合结果。`,
        '1. 后台裁决结论: ...',
        '2. 它修正了我原先判断的地方: ...',
        '3. 我仍然保留的判断: ...',
        '4. 最终更新后的结论: ...',
        '5. 对你下一步行动的影响: ...',
      ];
  return [
    '[超限思考·后台结果已完成]',
    '来源: supathink 插件事件,不是用户原话;不得称为“你说/你发来”。',
    `event_type: ${delivery.event_type}`,
    `method: ${label}`,
    'requires_visible_delivery: true',
    `user_visible_task: ${delivery.user_visible_task}`,
    `original_user_message_id: ${delivery.original_user_message_id || ''}`,
    `result_file: ${delivery.result_file || ''}`,
    'delivery_contract: send_standalone_final_answer',
    '交付规则: 现在必须先向用户发送一条独立可见消息交付这个后台结果;不要只把它吸收到本轮回答里。若本轮还有用户新问题,先交付后台结果,再另起一段回答新问题。若宿主提示 final 不自动送达,必须使用可见消息发送工具。',
    '固定输出模板:',
    template.join('\n'),
    '后台结果摘要:',
    summary,
  ].join('\n');
}

function drainPendingContext(sid, state) {
  const turn = state.turn || 0;
  const inflight = Array.isArray(state.pending_delivery_inflight) ? state.pending_delivery_inflight : [];
  const requeuedInflight = inflight.map((d) => ({
    ...d,
    status: 'result_ready',
    requeued_from: 'inflight',
    attempt_count: Number(d.attempt_count) || 0,
  }));
  const deliveries = (Array.isArray(state.pending_deliveries) ? state.pending_deliveries : []).concat(requeuedInflight);
  const rawFindings = Array.isArray(state.pending_findings) ? state.pending_findings : [];
  const findings = [];
  const legacyDeliveries = [];
  for (const item of rawFindings) {
    if (isBackgroundFinding(item)) {
      // 旧 finding 只在和现有 structured delivery 明确同 method/同 summary 时去重;
      // 混合升级态里不同后台结果仍必须各自强交付,不能因任意 delivery 存在而清空。
      const legacy = legacyDeliveryFromFinding(item, turn);
      if (!deliveries.concat(legacyDeliveries).some((d) => sameBackgroundDelivery(d, legacy))) {
        legacyDeliveries.push(legacy);
      }
    } else {
      findings.push(item);
    }
  }
  state.pending_deliveries = [];
  state.pending_delivery_inflight = [];
  state.pending_findings = [];

  const parts = [];
  const allDeliveries = deliveries.concat(legacyDeliveries);
  if (allDeliveries.length) {
    const inflight = allDeliveries.map((d) => ({ ...d, status: 'delivery_requested', requested_at: new Date().toISOString() }));
    state.pending_delivery_inflight = (state.pending_delivery_inflight || []).concat(inflight);
    for (const d of inflight) {
      appendTrace(sid, {
        turn,
        type: 'background_result_delivery_requested',
        delivery_id: d.id,
        event_type: d.event_type,
        method: d.method,
        contract: d.delivery_contract,
      });
    }
    parts.push(allDeliveries.map(renderBackgroundDelivery).join('\n\n'));
  }
  if (findings.length) {
    parts.push('[超限思考·上轮发现]\n来源: supathink 插件事件,不是用户原话;请视需要向用户澄清或修正。\n' + findings.map((p) => `⚠ ${p}`).join('\n'));
  }
  return { parts, requiresVisibleDelivery: allDeliveries.length > 0 };
}

function escapeRegExp(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactAsciiTokenRe(token) {
  return new RegExp(`(^|[^a-z0-9-])${escapeRegExp(token)}(?![a-z0-9-])`, 'i');
}

function deliveryEvidenceFragments(delivery) {
  return String((delivery && delivery.result_summary) || '')
    .replace(/^【[^】]+】/, '')
    .split(/[\n\r,，。；;:：]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4)
    .filter((s) => !/^(?:panel|panel-lite|debate|delphi|redblue|judge|lite)?\s*(?:综合|裁决|未能完成|未能成组)?$/i.test(s));
}

function deliveryDirectEvidence(content, delivery, siblings = []) {
  const text = String(content || '');
  const lower = text.toLowerCase();
  const id = delivery && delivery.id ? String(delivery.id).toLowerCase() : '';
  if (id && lower.includes(id)) {
    return !(siblings || []).some((sibling) => String((sibling && sibling.id) || '').toLowerCase() === id);
  }
  const file = delivery && delivery.result_file ? String(delivery.result_file).toLowerCase() : '';
  if (file && file !== 'trace.jsonl' && lower.includes(file)) {
    return !(siblings || []).some((sibling) => String((sibling && sibling.result_file) || '').toLowerCase() === file);
  }
  return false;
}

function normalizedDeliveryFragments(delivery) {
  return deliveryEvidenceFragments(delivery)
    .map((fragment) => normalizeDeliverySummaryText(fragment, 600))
    .filter((fragment) => fragment.length >= 4);
}

function deliverySummaryEvidence(content, delivery, siblings = []) {
  const text = String(content || '');
  const normalizedText = normalizeDeliverySummaryText(text, 600);
  const siblingFragments = new Set();
  for (const sibling of siblings || []) {
    for (const fragment of normalizedDeliveryFragments(sibling)) siblingFragments.add(fragment);
  }
  return normalizedDeliveryFragments(delivery).some((normalized) => {
    if (!normalizedText.includes(normalized)) return false;
    return !siblingFragments.has(normalized);
  });
}

function deliveryFieldValues(text, fields) {
  const names = fields.map(escapeRegExp).join('|');
  const re = new RegExp(`(?:${names})[:：]?\\s*([^\\n。；;]+)`, 'g');
  const values = [];
  let match;
  while ((match = re.exec(String(text || '')))) values.push((match[1] || '').trim());
  return values;
}

function substantiveDeliveryValue(value) {
  const raw = String(value || '').trim();
  const normalized = normalizeDeliverySummaryText(raw, 80);
  if (normalized.length < 4) return false;
  return !/^(?:收到|已收到|好的|好|ok|okay|已处理.*|我已处理.*|处理了.*|按规则.*|按要求.*|规则要求.*|见上|如上|同上|无|没有|暂无|none|no|na|notapplicable|不适用)$/.test(normalized);
}

function deliveryContractSatisfied(content, delivery) {
  const text = String(content || '').trim();
  if (!text) return false;
  const method = normalizeBackgroundMethod(delivery.method || 'background', 'background').toLowerCase();
  const label = panelDisplayName(delivery.method).toLowerCase();
  const aliases = {
    'panel': [exactAsciiTokenRe('panel'), /异构三席|三席\s*(?:\+|加)?\s*Judge|三席\s*并行/i],
    'panel-lite': [exactAsciiTokenRe('panel-lite'), exactAsciiTokenRe('panellite'), /三视角|单模型三视角/],
    'debate': [exactAsciiTokenRe('debate'), /正反|论辩|辩论/],
    'delphi': [exactAsciiTokenRe('delphi'), /匿名汇总|独立估计/],
    'redblue': [exactAsciiTokenRe('redblue'), /红蓝|红攻|蓝案/],
    'judge': [exactAsciiTokenRe('judge'), /后台裁决|Judge\s*裁决/i],
    'unresolved-disagreement': [/未决分歧/],
    'altitude': [exactAsciiTokenRe('altitude'), /七轴|目标回溯|代理指标/],
  };
  const methodOk = !method || method === 'background'
    || (aliases[method] || [exactAsciiTokenRe(method), exactAsciiTokenRe(label)]).some((re) => re.test(text));
  const baseOk = text.length >= 24 && (method === 'background' || !method || methodOk);
  if (!baseOk) return false;
  if (delivery.event_type === 'background_result_failed') {
    const reason = (text.match(/未完成原因[:：]\s*([^\n。；;]+)/) || [])[1] || '';
    const reasonOk = !!reason && !/^\s*(?:无|没有|暂无|none|no|n\/a|na|not\s+applicable|不适用|无需|-)\s*$/i.test(reason);
    const failureStateOk = [
      /后台执行结果[:：]\s*[^。\n]*(?:未能|未完成|失败|无法|不能|出错|超时|缺席|不可用|没有)/,
      /(?:未能完成|未能成组|执行失败|后台失败|调用失败|超时|缺席|不可用|无有效综合文本)/,
    ].some((re) => re.test(text));
    const noConclusionOk = [
      /目前不能得出的结论[:：]\s*\S/,
      /(?:不能|无法|不可|不要)[^。\n]{0,16}(?:得出|伪造|确认)[^。\n]{0,16}(?:结论|综合)/,
    ].some((re) => re.test(text));
    const successConclusion = /(?:后台裁决结论|最终更新后的结论|对你下一步行动的影响)[:：]\s*(?![^。\n]*(?:不能|无法|不可|未能|未完成|失败|不要|不能得出))/m.test(text);
    return failureStateOk && (reasonOk || noConclusionOk) && !successConclusion;
  }
  const values = deliveryFieldValues(text, [
    '后台裁决结论',
    '后台执行结果',
    '后台综合结果',
    '后台综合结论',
    '后台分析结果',
    '最终更新后的结论',
    '对你下一步行动的影响',
  ]);
  return values.some(substantiveDeliveryValue);
}

function settleInflightDeliveries(sid, content, turnFallback) {
  const st = loadState(sid);
  const inflight = Array.isArray(st.pending_delivery_inflight) ? st.pending_delivery_inflight : [];
  if (!inflight.length) return { delivered: 0, attempted: 0, pending: 0, contract_satisfied: true };
  const now = new Date().toISOString();
  const delivered = [];
  const pending = [];
  for (const d of inflight) {
    const contractOk = deliveryContractSatisfied(content, d);
    const siblings = inflight.length > 1
      ? inflight.filter((other) => other !== d)
      : [];
    const specificOk = deliveryDirectEvidence(content, d, siblings) || deliverySummaryEvidence(content, d, siblings);
    const canDeliver = contractOk && (
      inflight.length <= 1 || specificOk
    );
    if (canDeliver) {
      delivered.push(d);
    } else {
      pending.push({
        ...d,
        status: 'result_ready',
        last_attempt_at: now,
        attempt_count: (Number(d.attempt_count) || 0) + 1,
      });
    }
  }
  st.pending_delivery_inflight = [];
  if (pending.length) appendPendingDeliveries(st, pending);
  if (delivered.length) st.delivered_deliveries = (st.delivered_deliveries || []).concat(delivered.map((d) => ({
    id: d.id,
    method: d.method,
    delivered_at: now,
  }))).slice(-20);
  saveState(sid, st);
  const text = String(content || '');
  const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  for (const d of pending) {
    appendTrace(sid, {
      turn: st.turn || turnFallback || 0,
      type: 'background_result_delivery_attempted',
      delivery_id: d.id,
      event_type: d.event_type,
      method: d.method,
      contract: d.delivery_contract,
      contract_satisfied: false,
      content_hash: hash,
      chars: text.length,
      attempt_count: d.attempt_count,
    });
  }
  for (const d of delivered) {
    appendTrace(sid, {
      turn: st.turn || turnFallback || 0,
      type: 'background_result_delivered',
      delivery_id: d.id,
      event_type: d.event_type,
      method: d.method,
      content_hash: hash,
      chars: text.length,
    });
  }
  statusFile(sid, pending.length ? `⚠ supathink:${pending.map((d) => d.method).join('/')} 结果待重新交付` : null);
  return {
    delivered: delivered.length,
    attempted: inflight.length,
    pending: pending.length,
    contract_satisfied: pending.length === 0,
  };
}

const CLAIM_VERDICTS = ['supported', 'refuted', 'not_found', 'skipped'];

function normalizeClaimVerdict(claim) {
  return CLAIM_VERDICTS.includes(claim && claim.verdict) ? claim.verdict : 'not_found';
}

function appendClaimVerificationTrace(sid, turn, claims) {
  for (const c of claims || []) {
    if (!c.verdict || (c.type !== 'fact' && c.type !== 'citation')) continue;
    const verdict = normalizeClaimVerdict(c);
    appendTrace(sid, {
      turn,
      type: 'verification_result',
      claim_id: c.id,
      verdict,
      raw_verdict: verdict === c.verdict ? undefined : c.verdict,
      source: c.source || c.ref || null,
      latency_ms: null,
      cache_hit: false,
    });
  }
}

function refutedClaimAnnotations(claims) {
  return (claims || [])
    .filter((c) => normalizeClaimVerdict(c) === 'refuted' && (c.type === 'fact' || c.type === 'citation'))
    .map((c) => ({ severity: 'blocker', issue: `核验否定:「${String(c.text || c.id || '').slice(0, 120)}」${c.ref ? ` (${c.ref})` : ''}` }));
}

function applyForceToDecision(decision, force) {
  if (force === 'off') {
    decision.mode = 'off';
    decision.triggers.push('user_fast');
  }
  if (force === 'full') {
    decision.mode = 'full';
    decision.triggers.push('user_slow');
    if (!decision.intent) decision.intent = 'decide';
    if (!decision.menu) decision.menu = pickMenu(decision.intent);
  }
}

function appendMethodContext(parts, decision, prompt) {
  if (detectSlowFull(prompt)) {
    parts.push('[超限思考 /slow-full] 请先自出 claim 账本再作答:以 JSON 列出你的答案将依赖的各项 {fact/citation/assumption/inference},citation 带 ref;随后给正文。账本与正文都将被核验。');
  }
  if (decision.mode !== 'off') {
    if (decision.menu) parts.push(renderMenu(decision.menu));
    if (STANCE_TIP[decision.stance_hint]) parts.push(`「站位提示(软,可无视)」${STANCE_TIP[decision.stance_hint]}`);
    if (decision.stance_hint === 'coach_gate_check') {
      parts.push('[超限思考] 检测到交权信号:按超限思考协议第 4 条执行主导权门——先区分「大事压顶想要脚手架」与「真实危机」;危机则不接管、关怀并引向真实的人;非危机则显式确认授权范围后再有界主导。');
    }
  }
}

// ---------- 路由处理 ----------
async function onSessionStart(payload) {
  if (isCriticSession(payload)) return {};
  const sid = payload.session_id || 'unknown';
  const state = loadState(sid);
  state.cwd = payload.cwd;
  state.host = detectHost(payload);
  state.ledger = state.ledger || ledgerLib.init(); // 目标账本(§5.1):SessionStart 初始化,默认 unconfirmed
  saveState(sid, state);
  ping(loadConfig(payload.cwd).deepseek).then((r) => dlog(`warm ping session=${sid} ok=${r.ok}`)); // 预热,不阻塞
  return {};
}

async function onUserPrompt(payload) {
  if (isCriticSession(payload)) return {};
  const sid = payload.session_id || 'unknown';
  const cfg = loadConfig(payload.cwd);
  const force = detectForce(payload.prompt);

  // /st 帮助入口(TG 菜单唯一合法条目 + CC/Codex 通用)
  if (detectHelp(payload.prompt)) {
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `[超限思考] 请把下列命令清单原样呈现给用户:\n${ST_COMMANDS.join('\n')}` }, suppressOutput: true };
  }

  // 北极星标记(§16):/st:win —— 三宿主聊天内一键记录真实救场
  const win = detectWin(payload.prompt);
  if (win) {
    const st = loadState(sid);
    appendTrace(sid, { turn: st.turn || 0, type: 'intercept_win', desc: win.desc });
    return {
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `[超限思考] 北极星已记录:「${win.desc}」——这是本系统存在意义的计数。请向用户简短确认,并感谢反馈。` },
      suppressOutput: true,
    };
  }

  // 会话级开关(/st:on /st:off):写 state 并让 Proposer 确认,本轮不做校验
  const toggle = detectSessionToggle(payload.prompt);
  if (toggle) {
    const st = loadState(sid);
    st.turn = (st.turn || 0) + 1;
    st.inactive = false;
    st.session_auto = toggle === 'on';
    st.last_mode = 'off';
    st.critic_loops = 0;
    st.cwd = payload.cwd;
    saveState(sid, st);
    appendTrace(sid, { turn: st.turn, type: 'route_decision', mode: 'off', stance_hint: null, triggers: [`session_${toggle}`], menu: [] });
    return {
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `[超限思考] 本会话自动分档已${toggle === 'on' ? '开启(Router 将按需 off/light/full)' : '关闭(仅 /st:slow 可唤起)'},请用一句话向用户确认。` },
      suppressOutput: true,
    };
  }

  // 多模型工作流(§8):/st:panel /st:panel-lite /st:debate /st:delphi /st:redblue ——
  // 后台并行,综合结果下一轮作为强制可见交付事件呈现(hook 10s 窗内无法同步等 panel)
  const panelMode = detectPanel(payload.prompt);
  if (panelMode) {
    const st = loadState(sid);
    st.turn = (st.turn || 0) + 1;
    st.inactive = false;
    st.last_mode = 'off'; // panel 发起轮本身不过 Critic
    st.critic_loops = 0;
    st.cwd = payload.cwd;
    saveState(sid, st);
    const question = stripPanelQuestion(payload.prompt) || st.last_prompt || '(空议题)';
    appendTrace(sid, { turn: st.turn, type: 'route_decision', mode: 'off', stance_hint: null, triggers: [`panel_${panelMode}`], menu: [] });
    launchPanelAsync(sid, st.turn, question, panelMode, cfg);
    return {
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `[超限思考] ${panelDisplayName(panelMode)} 已在后台运行,议题:「${question.slice(0, 80)}」。请先给出你自己的独立初步分析(不要等待后台完成);后台完成后会以“必须独立可见交付”的事件返回,不能只作为参考上下文吸收。` },
      suppressOutput: true,
    };
  }

  // /st:altitude:手动 Navigator 抬头(§8)——本轮 Stop 后强制跑 Navigator,结果下一轮强制可见交付
  if (detectAltitude(payload.prompt)) {
    const st = loadState(sid);
    st.turn = (st.turn || 0) + 1;
    st.inactive = false;
    st.last_mode = st.last_mode === 'full' ? 'full' : 'light'; // 保证 Stop 侧进入检查路径
    st.force_navigator = true;
    st.critic_loops = 0;
    st.cwd = payload.cwd;
    st.last_prompt = stripAltitudeQuestion(payload.prompt).slice(0, 2000);
    saveState(sid, st);
    appendTrace(sid, { turn: st.turn, type: 'route_decision', mode: st.last_mode, stance_hint: null, triggers: ['manual_altitude'], menu: [] });
    return {
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '[超限思考] 已安排 Navigator 抬头(目标回溯/代理警报/约束相容七轴),结果于本轮交付后异步产出,并在下一轮作为强制可见交付事件呈现。请正常回答。' },
      suppressOutput: true,
    };
  }

  // /st:playbook-save 是显式元动作;强认可捕获是本地学习提示。默认 off 时也必须可达;
  // 二者只读写本地 playbook/trace,不注入方法菜单、不触发模型调用。
  const pbSave = pbLib.detectSave(payload.prompt);
  if (pbSave) {
    const st = loadState(sid);
    st.turn = (st.turn || 0) + 1;
    st.inactive = false;
    st.last_mode = 'off';
    st.cwd = payload.cwd;
    saveState(sid, st);
    const recipe = st.last_recipe || { mode: 'full', intent: null };
    const pb = pbLib.save(pbSave.name, pbSave.scope, recipe, recipe.source_prompt || st.last_prompt);
    appendTrace(sid, { turn: st.turn, type: 'playbook_capture', playbook_id: pb.id, match_scope: pb.scope, recipe: pb.recipe });
    return {
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `[超限思考] playbook 已保存:${pb.name}(id=${pb.id},范围「${pb.scope}」,关键词 ${pb.match.keywords.join('/')})。文件在 ~/.supathink/playbooks/${pb.id}.jsonc,keywords/scope 可手改,删除即退役。请向用户确认。` },
      suppressOutput: true,
    };
  }

  if (!force && pbLib.RE_STRONG_APPROVE.test(payload.prompt || '') && sessionStateExists(sid)) {
    const st = loadState(sid);
    st.turn = (st.turn || 0) + 1;
    st.inactive = false;
    st.last_mode = 'off';
    st.cwd = payload.cwd;
    appendTrace(sid, { turn: st.turn, type: 'user_feedback', signal: 'strong_approve', raw: String(payload.prompt).slice(0, 120) });
    const r = st.last_recipe;
    const notable = r && (r.mode === 'full' || r.panel || (r.triggers || []).some((t) => String(t).startsWith('user_')));
    const recentlyAsked = st.last_pb_suggest_turn && st.turn - st.last_pb_suggest_turn < 5;
    if (notable && !recentlyAsked) {
      st.last_pb_suggest_turn = st.turn;
      saveState(sid, st);
      const parts0 = [`[超限思考] 检测到强认可。本次思考配方有特点(${r.mode}${r.panel ? '+panel' : ''}${r.intent ? '/' + r.intent : ''})。请询问用户:「要把这次的思考配方存为 playbook,下次同类命题自动复用吗?保存请回复:/st:playbook-save <名称> <范围:仅此话题|此类决策|所有业务策略>;或保持灵活不保存。」另:若用户的认可是指某次拦截让他避免了实际损失,按协议第 7 条代记北极星(supathink win)。`];
      return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: parts0.join('\n') }, suppressOutput: true };
    }
    saveState(sid, st);
    return {};
  }

  // 生效 auto:会话开关 > 项目/用户配置
  const pre = sessionStateExists(sid) ? loadState(sid) : null;
  const effAuto = pre && typeof pre.session_auto === 'boolean' ? pre.session_auto : cfg.auto;

  if (!effAuto && !force) {
    if (sessionStateExists(sid)) {
      const st = loadState(sid);
      st.turn = (st.turn || 0) + 1;
      st.last_mode = 'off';
      st.inactive = true;
      const drained = drainPendingContext(sid, st);
      if (drained.parts.length) st.inactive = false;
      saveState(sid, st);
      if (drained.parts.length) {
        statusFile(sid, null);
        return {
          hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: drained.parts.join('\n\n') },
          suppressOutput: true,
        };
      }
    }
    return {};
  }

  const decision = route(payload.prompt);
  applyForceToDecision(decision, force);
  // 优先级链(§11):显式 slash > playbook > 动态默认;playbook 只抬升 mode,stance 教练位强制剥离(P8)
  if (!force) {
    const pb = pbLib.match(payload.prompt, pbLib.loadAll());
    if (pb) {
      pbLib.apply(decision, pb);
      if (decision.mode !== 'off' && !decision.menu) decision.menu = pickMenu(decision.intent || 'decide');
      decision.playbook_id = pb.id;
    }
  }

  const state = loadState(sid);
  state.turn = (state.turn || 0) + 1;
  state.inactive = false;
  state.last_mode = decision.mode;
  state.last_intent = decision.intent;
  state.last_triggers = decision.triggers;
  state.last_prompt = String(payload.prompt || '').slice(0, 2000);
  state.critic_loops = 0;
  state.cwd = payload.cwd;
  updateGoalTracking(state, payload.prompt); // 目标账本随轮更新(§5.1,unconfirmed 起步;§5.3 两轴素材)
  const drained = drainPendingContext(sid, state);
  saveState(sid, state);
  statusFile(sid, null);

  appendTrace(sid, {
    turn: state.turn, type: 'route_decision', mode: decision.mode,
    stance_hint: decision.stance_hint, triggers: decision.triggers, menu: decision.menu || [],
    playbook_id: decision.playbook_id || undefined,
  });

  const parts = drained.parts;
  appendMethodContext(parts, decision, payload.prompt);
  if (!parts.length) return {};
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: parts.join('\n\n') }, suppressOutput: true };
}

async function onStop(payload) {
  if (isCriticSession(payload)) return {};
  const t0 = Date.now();
  const sid = payload.session_id || 'unknown';
  let esc = consumeEscalation(payload.cwd);
  const hadSession = sessionStateExists(sid);
  if (!hadSession && !esc) return {};
  const state = loadState(sid);
  const cfg = loadConfig(state.cwd || payload.cwd);
  const autoForEscalation = typeof state.session_auto === 'boolean' ? state.session_auto : cfg.auto;
  if (esc && !autoForEscalation) {
    if (hadSession) {
      appendTrace(sid, {
        turn: state.turn || 0,
        type: 'escalation_ignored',
        reason: 'auto_off',
        requested_mode: esc.mode,
        methods: esc.methods || undefined,
      });
    }
    esc = null;
    if (!hadSession) return {};
  }
  if (state.inactive && !esc) return {};
  let mode = state.last_mode || 'off';
  const RANK = { off: 0, light: 1, full: 2 };
  if (esc && (RANK[esc.mode] || 0) > (RANK[mode] || 0)) {
    mode = esc.mode;
    state.last_mode = mode;
    state.inactive = false;
    state.turn = state.turn || 1;
    state.cwd = state.cwd || payload.cwd;
    saveState(sid, state);
    appendTrace(sid, {
      turn: state.turn, type: 'route_decision', mode,
      stance_hint: null, triggers: ['proposer_self_judged'], menu: [],
      methods: esc.methods || undefined, reason: esc.reason || undefined,
    });
    if (esc.methods) state.declared_methods = esc.methods; // 方法契约素材(B3)
  }
  const turn = state.turn || 0;

  const finalTrace = (extra) => {
    try {
      const sDelivery = loadState(sid);
      if (Array.isArray(sDelivery.pending_delivery_inflight) && sDelivery.pending_delivery_inflight.length) {
        settleInflightDeliveries(sid, draftFrom(payload), turn);
      }
    } catch (_) {}
    try { // 记录本轮已运行配方(§11 认可捕获素材;角色形式)
      const s3 = loadState(sid);
      s3.last_recipe = { mode: s3.last_mode || mode, intent: s3.last_intent || null, triggers: s3.last_triggers || [], panel: false, source_prompt: s3.last_prompt || '' };
      saveState(sid, s3);
    } catch (_) {}
    appendTrace(sid, {
      turn, type: 'final_delivered', mode: state.last_mode || mode,
      loops: state.critic_loops || 0,
      footer: (state.critic_loops || 0) > 0 ? 'proposer-inline' : null,
      added_latency_ms: Date.now() - t0, ...extra,
    });
  };

  if (mode === 'off') { finalTrace({}); return {}; }

  const loops = state.critic_loops || 0;
  if (payload.stop_hook_active && loops >= 2) {
    // §3.2 Judge 兜底:循环上限已达仍有争议 → 一次 Judge 调用,或标记未决分歧(P7)
    if (state.last_severe && state.last_severe.length && state.last_severe_turn === turn) {
      const positions = { critic: state.last_severe, proposer: 'Proposer 修订后保留(达循环上限)' };
      const caps = capsLib.load();
      const judgeEng = resolveEngine(caps.roles.judge.model, cfg);
      if (judgeEng.available) {
        const draftNow = draftFrom(payload);
        setImmediate(async () => {
          try {
            const jr = await judgeEng.call(`你是 Judge(不数票;钢人化双方;不收敛就输出分歧)。Critic 批注与 Proposer 最终稿之争:\n【Critic 批注】${state.last_severe.join('\n')}\n【Proposer 最终稿(节选)】${String(draftNow).slice(0, 3000)}\n输出:各方最强版本一句 + 裁决或未决分歧(带置信)。`, { maxTokens: 1200, timeoutMs: 60_000 });
            const s2 = loadState(sid);
            if (jr) {
              appendTrace(sid, { turn, type: 'disagreement', ref_id: `t${turn}`, positions, resolution: 'judge' });
              const text = `【Judge 裁决(${judgeEng.model})】${String(jr.content).slice(0, 500)}`;
              const delivery = makeBackgroundEventDelivery(turn, 'judge', state.last_prompt || '', text, 'trace.jsonl', false);
              s2.pending_findings = (s2.pending_findings || []).concat([text]);
              appendPendingDeliveries(s2, [delivery]);
              traceBackgroundReady(sid, turn, delivery);
            } else {
              appendTrace(sid, { turn, type: 'disagreement', ref_id: `t${turn}`, positions, resolution: 'unresolved' });
              const text = `【未决分歧】Critic:${state.last_severe[0]}…(Judge 调用失败,按 P7 如实呈现)`;
              const delivery = makeBackgroundEventDelivery(turn, 'unresolved-disagreement', state.last_prompt || '', text, 'trace.jsonl', true);
              s2.pending_findings = (s2.pending_findings || []).concat([text]);
              appendPendingDeliveries(s2, [delivery]);
              traceBackgroundReady(sid, turn, delivery);
            }
            saveState(sid, s2);
          } catch (e) { dlog(`judge error: ${e.message}`); }
        });
      } else {
        appendTrace(sid, { turn, type: 'disagreement', ref_id: `t${turn}`, positions, resolution: 'unresolved' });
        const text = `【未决分歧】循环上限已达,Critic 保留:${state.last_severe[0]}…(judge 引擎未配置,按 P7 如实呈现,勿捏共识)`;
        const delivery = makeBackgroundEventDelivery(turn, 'unresolved-disagreement', state.last_prompt || '', text, 'trace.jsonl', true);
        state.pending_findings = (state.pending_findings || []).concat([text]);
        appendPendingDeliveries(state, [delivery]);
        traceBackgroundReady(sid, turn, delivery);
        saveState(sid, state);
      }
    }
    finalTrace({ critic_status: 'loop_cap_reached' });
    return {};
  }

  const draft = draftFrom(payload);
  if (!draft) { finalTrace({ critic_status: 'no_draft' }); return {}; }
  appendTrace(sid, { turn, type: 'draft_captured', chars: draft.length, hash: crypto.createHash('sha256').update(draft).digest('hex').slice(0, 16) });
  cfg.host = state.host || detectHost(payload); // 宿主快模型回退:CC=haiku,Codex=gpt-5.4-mini(用户批示)

  const cache = cacheLib.load(state.cwd || payload.cwd);

  const doBlock = (severeLines) => {
    const fresh = loadState(sid); // onStop await 期间可能有 panel/Judge/altitude 异步写入,不能用旧快照覆盖。
    fresh.critic_loops = loops + 1;
    fresh.last_severe = severeLines.slice(0, 6); // Judge 兜底(§3.2)据此仲裁
    fresh.last_severe_turn = turn;
    // 只合并本轮 Critic/route 拥有的上下文字段;pending_* 等异步交付状态以 fresh 为准。
    fresh.last_mode = state.last_mode || fresh.last_mode;
    fresh.last_intent = state.last_intent || fresh.last_intent;
    fresh.last_triggers = state.last_triggers || fresh.last_triggers;
    fresh.last_prompt = state.last_prompt || fresh.last_prompt;
    fresh.cwd = state.cwd || fresh.cwd;
    fresh.host = state.host || fresh.host;
    if (state.declared_methods) fresh.declared_methods = state.declared_methods;
    const persisted = saveState(sid, fresh);
    if (!persisted) { finalTrace({ critic_status: 'block_aborted_save_failed' }); return {}; }
    return { decision: 'block', reason: `副驾批注:\n${severeLines.join('\n')}\n${PROTOCOL_FOOTER}` };
  };

  if (mode === 'light') {
    const fast = await fastCheck(draft, cfg, cache);
    if (fast.usage) quota({ session_id: sid, turn, event: 'fast_check', backend: 'deepseek', model: cfg.deepseek.model, duration_ms: fast.ms, usage: fast.usage });
    if (fast.blockers.length) {
      state.last_mode = 'full'; // §3.2:快查命中 blocker → 就地升级 full
      const lines = fast.blockers.map((b, i) => `${i + 1}. [blocker] ${b.issue}`);
      const blocked = doBlock(lines);
      if (blocked.decision) return blocked;
      return {};
    }
    // 放行 + 慢查异步(§3.2):结果经 下一轮注入 + statusline + supathink log 呈现
    finalTrace({ critic_status: fast.timed_out ? 'fast_timeout_pass' : 'fast_pass', fast_ms: fast.ms });
    setImmediate(() => runSlowPath(sid, turn, draft, state, cfg, cache).catch((e) => dlog(`slow-path error: ${e.message}`)));
    return {};
  }

  // full:Critic 全审 ∥ Navigator(§3.2 并行;账本注入,§5.1)
  // 方法契约(§7.1):escalate 声明 或 draft 内「本轮采用 X」
  const declared = state.declared_methods || (String(draft).match(/本轮采用\s*[::]?\s*([^\n。;;]{2,50})/) || [])[1] || null;
  const [review, nav] = await Promise.all([
    fullReview(draft, cfg, { declaredMethods: declared }),
    navigator.run('full', state.last_prompt || '', draft, cfg, { ledger: state.ledger, staleGoal: goalStale(state) }),
  ]);
  for (const f of nav.flags) appendTrace(sid, { turn, type: 'navigator_flag', axis: f.axis, severity: f.severity, issue: f.issue, ask: f.ask });
  if (nav.usage) quota({ session_id: sid, turn, event: 'navigator_run', backend: 'deepseek', model: cfg.deepseek.model, usage: nav.usage });
  if (!review) {
    const navMajor = nav.flags.filter((f) => f.severity === 'major');
    if (navMajor.length) {
      const lines = navMajor.map((f, i) => `${i + 1}. [对齐·${f.axis}] ${f.issue} → 建议向用户确认:${f.ask || '目标是否如此'}`);
      const blocked = doBlock(lines);
      if (blocked.decision) return blocked;
      return {};
    }
    finalTrace({ critic_status: 'critic_failed', backend: cfg.backend });
    return {};
  }
  quota({ session_id: sid, turn, event: 'critic_run', ...review.usage });
  appendTrace(sid, { turn, type: 'claims_extracted', claims: review.review.claims || [] });
  appendClaimVerificationTrace(sid, turn, review.review.claims || []);
  const refutedClaims = refutedClaimAnnotations(review.review.claims || []);
  const severe = (review.review.annotations || [])
    .filter((a) => a.severity === 'blocker' || a.severity === 'major')
    .concat(refutedClaims);
  const navMajor = nav.flags.filter((f) => f.severity === 'major');
  if (severe.length || navMajor.length) {
    const lines = severe.map((a, i) => `${i + 1}. [${a.severity}] ${a.issue}`)
      .concat(navMajor.map((f, i) => `${severe.length + i + 1}. [对齐·${f.axis}] ${f.issue} → 建议向用户确认:${f.ask || '目标是否如此'}`));
    const blocked = doBlock(lines);
    if (blocked.decision) return blocked;
    return {};
  }
  finalTrace({ critic_status: 'pass', annotations: (review.review.annotations || []).length });
  return {};
}

async function runSlowPath(sid, turn, draft, state, cfg, cache) {
  const force = !!state.force_navigator;
  if (force) { const s0 = loadState(sid); s0.force_navigator = false; saveState(sid, s0); } // 抬头一次性
  const [slow, nav] = await Promise.all([
    slowVerify(draft, cfg, cache),
    navigator.run('light', state.last_prompt || '', draft, cfg, { ledger: state.ledger, force, staleGoal: goalStale(state) }),
  ]);
  for (const u of slow.usage) quota({ session_id: sid, turn, event: 'slow_verify', backend: 'deepseek', model: cfg.deepseek.model, usage: u });
  if (nav.usage) quota({ session_id: sid, turn, event: 'navigator_run', backend: 'deepseek', model: cfg.deepseek.model, usage: nav.usage });
  appendTrace(sid, { turn, type: 'claims_extracted', claims: slow.claims });
  for (const r of slow.results) {
    appendTrace(sid, { turn, type: 'verification_result', claim_id: r.claim_id, verdict: r.verdict, source: r.source || null, latency_ms: null, cache_hit: !!r.cache_hit });
  }
  for (const f of nav.flags) appendTrace(sid, { turn, type: 'navigator_flag', axis: f.axis, severity: f.severity, issue: f.issue, ask: f.ask });
  const findings = [];
  const claimTextById = new Map((slow.claims || []).map((c) => [c.id, c.text || c.id]));
  for (const r of slow.results || []) {
    if (r.verdict === 'refuted') {
      findings.push(`[blocker] 慢查核验否定:「${String(claimTextById.get(r.claim_id) || r.claim_id).slice(0, 120)}」`);
    }
  }
  for (const a of slow.annotations) {
    if (a.severity === 'blocker' || a.severity === 'major') findings.push(`[${a.severity}] ${a.issue}`);
  }
  for (const f of nav.flags) if (f.severity === 'major' || force) findings.push(`[对齐·${f.axis}] ${f.issue}(${f.ask || ''})`); // 手动抬头时 minor 也呈现
  if (force && !findings.length) findings.push('[对齐·altitude] Navigator 七轴未发现需要打断的目标偏离;保持原回答方向即可。');
  if (findings.length) {
    const st = loadState(sid);
    if (force) {
      const delivery = makeBackgroundEventDelivery(turn, 'altitude', state.last_prompt || '', findings.join('\n'), 'trace.jsonl', false);
      appendPendingDeliveries(st, [delivery]);
      traceBackgroundReady(sid, turn, delivery);
    } else {
      st.pending_findings = (st.pending_findings || []).concat(findings).slice(0, 8);
    }
    saveState(sid, st);
    statusFile(sid, force ? '⚠ supathink:altitude 结果待交付' : `⚠ supathink:${findings.length} 条慢查发现待复核(下一轮注入 / supathink log 查看)`);
  }
}

async function onPreCompact(payload) {
  const sid = payload.session_id || 'unknown';
  try {
    const dir = path.join(ROOT, 'sessions', String(sid), 'snapshots');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'sessions', String(sid), 'state.json'), path.join(dir, `state.${Date.now()}.json`));
  } catch (_) {}
  return {};
}

async function onMessageSent(payload) {
  const sid = payload.session_id || 'unknown';
  return { ok: true, ...settleInflightDeliveries(sid, payload.content || '', 0) };
}

// 通用审稿 API(Phase 4,OpenClaw 等无 hook 生命周期的宿主/前端用):同步跑 分档+Critic+Navigator,返回批注
// 契约:POST /v1/review {prompt, draft, session_id?} → {mode, verdict:'pass'|'revise', annotations[], nav_flags[], footer}
function openclawPolicy(agent) {
  // agent 级策略(~/.supathink/openclaw.json):{"default":"off","agents":{"main":{"auto":true}}};默认关(P1)
  try {
    const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'openclaw.json'), 'utf8'));
    const a = (p.agents || {})[agent];
    if (a && typeof a.auto === 'boolean') return a.auto;
    return p.default === 'auto' || p.default === true;
  } catch (_) { return false; }
}

// OpenClaw 生成前处理(CC/Codex 的 UserPromptSubmit 等价物):before_prompt_build →
//  ① 漏斗上轮异步产出:显式后台工作走 pending_deliveries 强交付;普通慢查走 pending_findings 弱提醒(OpenClaw 侧唯一取用点);
//  ② 元命令(toggle/win/panel/altitude/help/slow 菜单)在 agent 张嘴前即时生效 + 注入指令,persona 下一句即干净确认。
// 检测单源 lib/config。OpenClaw 侧由本函数拥有 turn(唯一化 panel-<turn>.json;onReview 只审不计 turn)。
// 命令一律先于 auto 门(策略关的 agent 也能开关/查帮助)。协议兜底(无插件)路径由 onReview 转调本函数(见其 meta 守卫)。
const precmdIdem = new Map(); // sid → {prompt,result,ts}:同一轮 before_prompt_build 可能多次触发(上下文压缩重建),幂等复用上次结果,避免重复 drain/turn++/launch/win
async function onPrecmd(payload) {
  if (isCriticSession(payload)) return {};
  const sid = payload.session_id || 'oc-adhoc';
  const cwd = payload.cwd || '';
  const cfg = loadConfig(cwd);
  const prompt = String(payload.prompt || '');
  for (const [key, v] of precmdIdem) if (Date.now() - v.ts > 10_000) precmdIdem.delete(key);
  const cached = precmdIdem.get(sid);
  if (cached && cached.prompt === prompt && Date.now() - cached.ts < 10_000) return cached.result; // 重触发:原样回上次结果,副作用只在首触发发生(评审 re-fire 项)
  const st = loadState(sid);
  st.host = 'openclaw';
  st.cwd = cwd;
  st.turn = (st.turn || 0) + 1;
  const drained = drainPendingContext(sid, st);
  const parts = drained.parts;

  let cmd = null; // 元命令注入语(非命令则 null)
  const win = detectWin(prompt);
  const toggle = detectSessionToggle(prompt);
  const panelMode = detectPanel(prompt);
  const help = detectHelp(prompt);
  const altitude = detectAltitude(prompt);
  const force = detectForce(prompt);
  if (prompt && !help && !win && !toggle && !panelMode && !altitude) {
    st.last_prompt = prompt.slice(0, 2000);
    updateGoalTracking(st, prompt);
  }
  if (help) {
    cmd = `[超限思考] 请把下列命令清单原样呈现给用户(TG/OpenClaw 用无分隔符,如 /stslow /stpanel;打字 st:slow 亦可):\n${ST_COMMANDS.join('\n')}`;
  } else if (win) {
    appendTrace(sid, { turn: st.turn, type: 'intercept_win', desc: win.desc });
    cmd = `[超限思考] 北极星已记录:「${win.desc}」——这是本系统存在意义的计数。请向用户简短确认并感谢反馈。`;
  } else if (toggle) {
    st.session_auto = toggle === 'on';
    appendTrace(sid, { turn: st.turn, type: 'route_decision', mode: 'off', stance_hint: null, triggers: [`session_${toggle}`], menu: [] });
    cmd = `[超限思考] 本会话自动分档已${toggle === 'on' ? '开启(之后我会按需 off/light/full 替你想深一层)' : '关闭(仅 /stslow 可单轮唤起)'},请用一句话向用户确认。`;
  } else if (panelMode) {
    const question = stripPanelQuestion(prompt) || st.last_prompt || '(空议题)';
    appendTrace(sid, { turn: st.turn, type: 'route_decision', mode: 'off', stance_hint: null, triggers: [`panel_${panelMode}`], menu: [] });
    launchPanelAsync(sid, st.turn, question, panelMode, cfg);
    cmd = `[超限思考] ${panelDisplayName(panelMode)} 已在后台运行,议题:「${question.slice(0, 80)}」。请先给出你自己的独立初步分析(不要等待后台完成);后台完成后会以“必须独立可见交付”的事件返回,不能只作为参考上下文吸收。`;
  } else if (altitude) {
    // OpenClaw 无 onStop/runSlowPath(那是 CC/Codex 的独立 Navigator 异步路径),抬头改为生成前注入七轴自检指令,
    // agent 本轮内先对齐再作答——honest:不承诺跨轮独立核验(避免评审指出的空转假承诺)。
    const topic = stripAltitudeQuestion(prompt);
    if (topic) {
      st.last_prompt = topic.slice(0, 2000);
      updateGoalTracking(st, topic);
    }
    cmd = '[超限思考·抬头] 回答前先做一次对齐自检(七轴,简要即可):①目标回溯——用户真正要解决的是什么,当前方向有无偏离;②代理指标警报——是否在优化易衡量的代理目标而非真实目标;③约束相容——有无被忽略的硬约束/资源/边界;④隐藏假设;⑤时间尺度(短期解 vs 长期);⑥利益相关方;⑦可逆性(单向门更要慎)。发现偏离就先向用户点出再作答。';
  } else {
    const effAuto = typeof st.session_auto === 'boolean' ? st.session_auto : openclawPolicy(payload.agent || 'unknown');
    if (effAuto || force) {
      const decision = route(prompt);
      applyForceToDecision(decision, force);
      st.last_mode = decision.mode;
      st.last_intent = decision.intent;
      st.last_triggers = decision.triggers;
      st.critic_loops = 0;
      appendTrace(sid, {
        turn: st.turn,
        type: 'route_decision',
        mode: decision.mode,
        stance_hint: decision.stance_hint,
        triggers: decision.triggers,
        menu: decision.menu || [],
      });
      if (decision.mode !== 'off') {
        const p2 = [];
        appendMethodContext(p2, decision, prompt);
        if (p2.length) cmd = p2.join('\n\n');
      }
    }
  }
  if (cmd) parts.push(cmd);
  saveState(sid, st);
  const result = parts.length ? { additionalContext: parts.join('\n\n'), requiresVisibleDelivery: drained.requiresVisibleDelivery || undefined } : {};
  precmdIdem.set(sid, { prompt, result, ts: Date.now() });
  return result;
}

async function onReview(payload) {
  const t0 = Date.now();
  const sid = payload.session_id || 'review-adhoc';
  const agent = String(payload.agent || 'unknown');
  const cfg = loadConfig(payload.cwd || process.cwd());
  cfg.host = 'openclaw';
  const draft = String(payload.draft || '');

  // 激活链(与 CC/Codex 同构):本轮命令 > 会话开关 > agent 策略 > 默认关。
  // 注:元命令(/st:on|off·win·panel·altitude·help)已在生成前 onPrecmd 处理并即时生效,此处只管审稿强度与放行。
  const force = detectForce(payload.prompt);
  if (force === 'off') return { verdict: 'pass', skipped: 'user_fast' };
  // 元命令(help/win/toggle/panel):其"回答"只是确认语/清单/交接,插件路径已由生成前 onPrecmd 处理 → 此处跳过,
  // 不拿确认语去审(否则 route 可能因描述里的高危词——如 win 里的「删库」——误判 full 空转 revise)。
  // /st:altitude 不列入:它经 onPrecmd 注入七轴自检后产出的是实质回答,应照常可审。
  // 协议兜底路径(无插件,transport 非 openclaw-plugin)则由本函数转调 onPrecmd 生效并回指令,守住 /v1/review 契约。
  const isMeta = detectHelp(payload.prompt) || detectWin(payload.prompt) || detectSessionToggle(payload.prompt) || detectPanel(payload.prompt);
  if (isMeta) {
    // 只在插件确认「本轮生成前 onPrecmd 确已跑过」(precmd_ran)时才跳过;否则(daemon 自愈窗内 precmd 没触达 / 协议兜底无插件)在此转调 onPrecmd 补生效——
    // 不盲信 transport,修评审指出的「daemon 重启窗内元命令被静默吞」回归。
    if (payload.precmd_ran) return { verdict: 'pass', skipped: 'precmd_handled', latency_ms: Date.now() - t0 };
    const pre = await onPrecmd({ ...payload, session_id: sid }); // 用 onReview 已解析的 sid,避免 adhoc 默认名分叉
    if (!pre.additionalContext) return { verdict: 'pass' };
    let instruction = pre.additionalContext;
    if (detectPanel(payload.prompt)) instruction += `\n(无插件兜底:合议综合若未自动出现,请下一轮 exec 读取 ~/.supathink/sessions/${sid}/panel-*.json 呈现)`;
    return { verdict: 'revise', instruction };
  }
  const st0 = sessionStateExists(sid) ? loadState(sid) : null;
  const effAuto = st0 && typeof st0.session_auto === 'boolean' ? st0.session_auto : openclawPolicy(agent);
  if (!effAuto && force !== 'full') {
    // 策略关且未强制:毫秒级放行;不接受旧协议/旧缓存带来的 self_judged 绕过默认关。
    return { verdict: 'pass', skipped: 'agent_policy_off', latency_ms: Date.now() - t0 };
  }

  if (!draft) return { error: 'draft 必填' };
  const decision = route(payload.prompt || '');
  const requestedMode = ['light', 'full'].includes(payload.mode) ? payload.mode : null;
  // 插件通道每次交付都会调进来 → 必须尊重 off(P1:闲聊零打扰);
  // self_judged 只在 effAuto 已开启的兜底路径里最低按 light。
  if (payload.transport === 'openclaw-plugin' && decision.mode === 'off' && force !== 'full' && !payload.self_judged && !requestedMode) {
    return { verdict: 'pass', skipped: 'route_off', latency_ms: Date.now() - t0 };
  }
  const mode = force === 'full' ? 'full' : requestedMode || (decision.mode === 'off' ? 'light' : decision.mode);
  appendTrace(sid, { turn: 0, type: 'route_decision', mode, stance_hint: decision.stance_hint, triggers: decision.triggers.concat(['review_api']), menu: [] });
  appendTrace(sid, { turn: 0, type: 'draft_captured', chars: draft.length, hash: crypto.createHash('sha256').update(draft).digest('hex').slice(0, 16) });
  const [review, nav] = await Promise.all([
    fullReview(draft, cfg),
    navigator.run(mode, payload.prompt || '', draft, cfg, { ledger: st0 ? st0.ledger : null, staleGoal: goalStale(st0) }),
  ]);
  if (review) quota({ session_id: sid, turn: 0, event: 'review_api', ...review.usage });
  for (const f of nav.flags) appendTrace(sid, { turn: 0, type: 'navigator_flag', axis: f.axis, severity: f.severity, issue: f.issue, ask: f.ask });
  if (!review) {
    appendTrace(sid, { turn: 0, type: 'final_delivered', mode, loops: 0, footer: 'degraded', added_latency_ms: Date.now() - t0 });
    const navMajor = nav.flags.filter((f) => f.severity === 'major');
    return {
      mode,
      verdict: navMajor.length ? 'revise' : 'pass',
      degraded: true,
      annotations: [],
      nav_flags: nav.flags,
      instruction: navMajor.length
        ? `副驾批注(Critic 调用失败,仅呈现 Navigator 对齐发现):\n${navMajor.map((f, i) => `${i + 1}. [对齐·${f.axis}] ${f.issue} → 建议向用户确认:${f.ask || ''}`).join('\n')}`
        : undefined,
      note: 'Critic 调用失败,按 §3.4 放行;Navigator 结果仍保留',
    };
  }
  appendTrace(sid, { turn: 0, type: 'claims_extracted', claims: review.review.claims || [] });
  appendClaimVerificationTrace(sid, 0, review.review.claims || []);
  const severeLevels = mode === 'light' ? ['blocker'] : ['blocker', 'major'];
  const severe = (review.review.annotations || [])
    .filter((a) => severeLevels.includes(a.severity))
    .concat(refutedClaimAnnotations(review.review.claims || []));
  const navMajor = nav.flags.filter((f) => f.severity === 'major');
  const verdict = severe.length || navMajor.length ? 'revise' : 'pass';
  appendTrace(sid, { turn: 0, type: 'final_delivered', mode, loops: 0, footer: verdict, added_latency_ms: Date.now() - t0 });
  return {
    mode,
    verdict,
    annotations: (review.review.annotations || []),
    nav_flags: nav.flags,
    instruction: verdict === 'revise'
      ? `副驾批注(逐条 采纳/驳回给理由/待查,修订后末尾保留「── 核验 ──」脚注):\n${severe.map((a, i) => `${i + 1}. [${a.severity}] ${a.issue}`).concat(navMajor.map((f, i) => `${severe.length + i + 1}. [对齐·${f.axis}] ${f.issue} → 建议向用户确认:${f.ask || ''}`)).join('\n')}`
      : '通过;可在末尾附「── 核验 ──」脚注列已查类别。',
    latency_ms: Date.now() - t0,
  };
}

function logSummary(sid) {
  const f = path.join(ROOT, 'sessions', String(sid), 'trace.jsonl');
  if (!fs.existsSync(f)) return `无 trace:${sid}`;
  const out = [];
  for (const line of fs.readFileSync(f, 'utf8').trim().split('\n')) {
    try {
      const e = JSON.parse(line);
      const ts = (e.ts || '').slice(11, 19);
      if (e.type === 'route_decision') out.push(`${ts} #${e.turn} 路由 → ${e.mode}${e.triggers && e.triggers.length ? `(${e.triggers.join(',')})` : ''}`);
      else if (e.type === 'verification_result') out.push(`${ts} #${e.turn}   核验 ${e.claim_id}: ${e.verdict}${e.cache_hit ? '(缓存)' : ''}`);
      else if (e.type === 'navigator_flag') out.push(`${ts} #${e.turn}   对齐 [${e.severity}] ${e.axis}: ${e.issue}`);
      else if (e.type === 'background_result_ready') out.push(`${ts} #${e.turn}   后台结果 ready ${e.method} → ${e.result_file}`);
      else if (e.type === 'background_result_delivery_requested') out.push(`${ts} #${e.turn}   后台结果要求可见交付 ${e.method} (${e.contract})`);
      else if (e.type === 'background_result_delivery_attempted') out.push(`${ts} #${e.turn}   后台结果交付尝试未满足契约 ${e.method}`);
      else if (e.type === 'background_result_delivered') out.push(`${ts} #${e.turn}   后台结果已可见发送 ${e.method}`);
      else if (e.type === 'final_delivered') out.push(`${ts} #${e.turn} 交付 mode=${e.mode} loops=${e.loops} +${e.added_latency_ms}ms ${e.critic_status || ''}`);
    } catch (_) {}
  }
  return out.join('\n') || '(空)';
}

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
  if (req.method === 'GET' && req.url === '/healthz') return send(200, { ok: true, pid: process.pid, engines: globalEngines || undefined });
  if (req.method === 'GET' && req.url.startsWith('/v1/log/')) return send(200, logSummary(decodeURIComponent(req.url.slice('/v1/log/'.length))), 'text/plain; charset=utf-8');
  if (req.method !== 'POST') return send(404, { error: 'not_found' });
  let body = '';
  req.on('data', (d) => { body += d; if (body.length > 4 * 1024 * 1024) req.destroy(); });
  req.on('end', async () => {
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch (_) { return send(200, {}); }
    try {
      if (isDisabled()) return send(200, disabledResponse(req.url));
      if (req.url === '/v1/hook/session-start') return send(200, await onSessionStart(payload));
      if (req.url === '/v1/hook/user-prompt') return send(200, await onUserPrompt(payload));
      if (req.url === '/v1/hook/precmd') return send(200, await onPrecmd(payload));
      if (req.url === '/v1/hook/stop') return send(200, await onStop(payload));
      if (req.url === '/v1/hook/message-sent') return send(200, await onMessageSent(payload));
      if (req.url === '/v1/hook/pre-compact') return send(200, await onPreCompact(payload));
      if (req.url === '/v1/review') return send(200, await onReview(payload));
      if (req.url === '/v1/panel') { // 模型/CLI 主动召集合议:挂到该 cwd 最新会话,结果下轮强制可见交付
        const want = String(payload.cwd || '');
        let best = null;
        const requestedSid = String(payload.session_id || '').trim();
        if (requestedSid) {
          if (/[\/\\]/.test(requestedSid)) return send(200, { error: 'invalid session_id' });
          try {
            const sf = path.join(ROOT, 'sessions', requestedSid, 'state.json');
            const st = JSON.parse(fs.readFileSync(sf, 'utf8'));
            if (want && st.cwd !== want) return send(200, { error: 'session cwd mismatch' });
            best = { sid: requestedSid, t: fs.statSync(sf).mtimeMs, turn: st.turn || 1 };
          } catch (_) {
            return send(200, { error: 'session not found' });
          }
        }
        try {
          for (const d of best ? [] : fs.readdirSync(path.join(ROOT, 'sessions'))) {
            try {
              const sf = path.join(ROOT, 'sessions', d, 'state.json');
              const st = JSON.parse(fs.readFileSync(sf, 'utf8'));
              if (st.cwd !== want) continue;
              const t = fs.statSync(sf).mtimeMs;
              if (!best || t > best.t) best = { sid: d, t, turn: st.turn || 1 };
            } catch (_) {}
          }
        } catch (_) {}
        if (!best) return send(200, { error: '该目录没有活跃会话(先发一轮消息再召集)' });
        const cfg2 = loadConfig(want);
        launchPanelAsync(best.sid, best.turn, String(payload.question || '').slice(0, 2000), ['lite','debate','delphi','redblue'].includes(payload.mode) ? payload.mode : 'panel', cfg2);
        return send(200, { ok: true, session_id: best.sid });
      }
      return send(404, { error: 'not_found' });
    } catch (e) {
      dlog(`handler error ${req.url}: ${e.stack || e.message}`);
      return send(200, {}); // 内部错误一律放行(§3.4)
    }
  });
});

let globalEngines = null;
async function validateOnStart() {
  const cfg = loadConfig(process.cwd());
  const out = {};
  out.deepseek = (await ping(cfg.deepseek)).ok ? 'ok' : 'fail';
  for (const ref of ['zhipu/glm', 'minimax/main']) {
    const e = resolveEngine(ref, cfg);
    if (!e.available) { out[ref] = 'unconfigured'; continue; }
    const r = await e.call('探活,只回两字母:OK', { maxTokens: 200, timeoutMs: 8_000 });
    out[ref] = r ? 'ok' : 'fail';
  }
  try { require('child_process').execSync('command -v gemini', { stdio: 'pipe' }); out['google/gemini'] = 'cli'; }
  catch (_) { out['google/gemini'] = (cfg.env || {}).SUPATHINK_GEMINI_API_KEY ? 'rest-key' : 'absent'; }
  try { require('child_process').execSync('command -v codex', { stdio: 'pipe' }); out['codex/gpt54mini'] = 'ok'; } catch (_) { out['codex/gpt54mini'] = 'absent'; }
  out.tavily = (cfg.env || {}).SUPATHINK_TAVILY_API_KEY ? 'configured' : 'absent';
  globalEngines = out;
  dlog('validate_on_start ' + JSON.stringify(out));
}

process.on('uncaughtException', (e) => dlog(`uncaught: ${e.stack || e.message}`));
process.on('unhandledRejection', (e) => dlog(`unhandled: ${e && e.stack ? e.stack : e}`));

server.listen(PORT, '127.0.0.1', () => {
  try { fs.writeFileSync(path.join(ROOT, 'daemon.pid'), String(process.pid)); } catch (_) {}
  dlog(`daemon up on 127.0.0.1:${PORT} pid=${process.pid}`);
  // 启动探活全量版(§10 policy.validate_on_start):逐引擎探活,失败只告警不阻断(§3.4)
  validateOnStart().catch((e) => dlog('validate_on_start error: ' + e.message));
});
server.on('error', (e) => { dlog(`listen error: ${e.message}`); process.exit(1); }); // 端口占用=已有实例,让位
