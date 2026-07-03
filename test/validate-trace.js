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
  'playbook_capture', 'intercept_win'];

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
  }
  return errs;
}

const root = process.argv[2] || path.join(os.homedir(), '.supathink', 'sessions');
let files = [];
for (const d of fs.readdirSync(root)) {
  const f = path.join(root, d, 'trace.jsonl');
  if (fs.existsSync(f)) files.push(f);
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
console.log(`\n${files.length} 个会话 / ${total} 行 / ${bad} 行违规`);
process.exit(bad ? 1 : 0);
