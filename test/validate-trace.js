#!/usr/bin/env node
'use strict';
// DoD③:校验 trace.jsonl 每行是否合 §9.4 schema
const fs = require('fs');
const path = require('path');
const os = require('os');

const VERDICTS = ['supported', 'refuted', 'not_found', 'skipped'];
const MODES = ['off', 'light', 'full'];
// §9.4 事件类型全集(后期 phase 的类型此处仅允许存在,字段不深查)
const TYPES = ['route_decision', 'draft_captured', 'claims_extracted', 'verification_result',
  'navigator_flag', 'reflection', 'disagreement', 'final_delivered', 'user_feedback',
  'playbook_capture', 'escalation_ignored', 'intercept_win', 'background_result_ready',
  'background_result_delivery_requested', 'background_result_delivery_attempted',
  'background_result_delivered'];

function checkLine(ev) {
  const errs = [];
  if (!ev.ts || isNaN(Date.parse(ev.ts))) errs.push('ts 缺失或非法');
  if (!ev.session_id) errs.push('session_id 缺失');
  if (typeof ev.turn !== 'number') errs.push('turn 缺失');
  if (!TYPES.includes(ev.type)) errs.push(`type 非法: ${ev.type}`);
  switch (ev.type) {
    case 'route_decision':
      if (!MODES.includes(ev.mode)) errs.push(`mode 非法: ${ev.mode}`);
      if (!Array.isArray(ev.triggers)) errs.push('triggers 非数组');
      if (!Array.isArray(ev.menu)) errs.push('menu 非数组');
      break;
    case 'draft_captured':
      if (typeof ev.chars !== 'number') errs.push('chars 缺失');
      if (typeof ev.hash !== 'string') errs.push('hash 缺失');
      break;
    case 'claims_extracted':
      if (!Array.isArray(ev.claims)) errs.push('claims 非数组');
      break;
    case 'verification_result':
      if (!ev.claim_id) errs.push('claim_id 缺失');
      if (!VERDICTS.includes(ev.verdict)) errs.push(`verdict 非法: ${ev.verdict}`);
      if (typeof ev.cache_hit !== 'boolean') errs.push('cache_hit 缺失');
      break;
    case 'final_delivered':
      if (!MODES.includes(ev.mode)) errs.push(`mode 非法: ${ev.mode}`);
      if (typeof ev.loops !== 'number') errs.push('loops 缺失');
      if (typeof ev.added_latency_ms !== 'number') errs.push('added_latency_ms 缺失');
      break;
    case 'background_result_ready':
      if (!ev.delivery_id) errs.push('delivery_id 缺失');
      if (!ev.event_type) errs.push('event_type 缺失');
      if (!ev.method) errs.push('method 缺失');
      break;
    case 'background_result_delivery_requested':
      if (!ev.delivery_id) errs.push('delivery_id 缺失');
      if (!ev.method) errs.push('method 缺失');
      if (!ev.contract) errs.push('contract 缺失');
      break;
    case 'background_result_delivery_attempted':
      if (!ev.delivery_id) errs.push('delivery_id 缺失');
      if (!ev.method) errs.push('method 缺失');
      if (ev.contract_satisfied !== false) errs.push('contract_satisfied 必须为 false');
      break;
    case 'background_result_delivered':
      if (!ev.delivery_id) errs.push('delivery_id 缺失');
      if (!ev.method) errs.push('method 缺失');
      if (!ev.content_hash) errs.push('content_hash 缺失');
      break;
  }
  return errs;
}

function runSelfTest() {
  const good = {
    ts: new Date().toISOString(),
    session_id: 'trace-selftest',
    turn: 1,
    type: 'route_decision',
    mode: 'off',
    triggers: [],
    menu: [],
  };
  const bad = { ...good, type: 'route_decision', mode: 'banana', menu: 'nope' };
  const goodErrs = checkLine(good);
  const badErrs = checkLine(bad);
  const bgBase = {
    ts: new Date().toISOString(),
    session_id: 'trace-selftest',
    turn: 2,
    delivery_id: 'bg-2-debate',
    event_type: 'background_result_ready',
    method: 'debate',
  };
  const bgEvents = [
    { ...bgBase, type: 'background_result_ready' },
    { ...bgBase, type: 'background_result_delivery_requested', contract: 'send_standalone_final_answer' },
    { ...bgBase, type: 'background_result_delivery_attempted', contract: 'send_standalone_final_answer', contract_satisfied: false },
    { ...bgBase, type: 'background_result_delivered', content_hash: 'a1b2c3d4' },
  ];
  const bgErrs = bgEvents.flatMap((ev) => checkLine(ev));
  if (goodErrs.length || bgErrs.length || badErrs.length < 2) {
    console.log(`✗ schema 自检失败 good=${goodErrs.join(';') || 'ok'} bg=${bgErrs.join(';') || 'ok'} bad=${badErrs.join(';') || 'missing'}`);
    return false;
  }
  return true;
}

const explicitRoot = !!process.argv[2];
const root = process.argv[2] || path.join(os.homedir(), '.supathink', 'sessions');
let files = [];
if (!runSelfTest()) process.exit(1);
if (!fs.existsSync(root)) {
  if (explicitRoot) {
    console.log(`✗ trace root 不存在:${root}`);
    process.exit(1);
  }
} else {
  for (const d of fs.readdirSync(root)) {
    const f = path.join(root, d, 'trace.jsonl');
    if (fs.existsSync(f)) files.push(f);
  }
}
let total = 0, bad = 0;
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
  lines.forEach((line, i) => {
    total++;
    let ev;
    try { ev = JSON.parse(line); } catch (_) { bad++; console.log(`✗ ${f}:${i + 1} 非法 JSON`); return; }
    const errs = checkLine(ev);
    if (errs.length) { bad++; console.log(`✗ ${f}:${i + 1} [${ev.type}] ${errs.join('; ')}`); }
  });
}
if (total === 0) {
  if (explicitRoot) {
    console.log(`✗ trace root 无样本:${root}`);
    process.exit(1);
  }
  console.log('无真实 trace 样本,已执行 schema 自检 fixture');
}
console.log(`\n${files.length} 个会话 / ${total} 行 / ${bad} 行违规`);
process.exit(bad ? 1 : 0);
