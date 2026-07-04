#!/usr/bin/env node
'use strict';
// playbook 复验/退役(§11 生命周期,Phase 4):confidence 随复验涨、随闲置衰;可 crontab 周跑,也可手跑
// 数据源(§11):统一读 trace(route_decision.playbook_id + 其后的 user_feedback)
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(os.homedir(), '.supathink');
const PB_DIR = path.join(ROOT, 'playbooks');
const LOG = path.join(ROOT, 'pb-review.log');

function log(line) { fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`); console.log(line); }

function globalBaseline() { // 动态基线:非 playbook 轮的认可率(§11 周期性对比)
  let pbA = 0, pbT = 0, gA = 0, gT = 0;
  try {
    for (const sid of fs.readdirSync(path.join(ROOT, 'sessions'))) {
      const f = path.join(ROOT, 'sessions', sid, 'trace.jsonl');
      if (!fs.existsSync(f)) continue;
      const evs = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
      evs.forEach((e, i) => {
        if (e.type !== 'route_decision') return;
        const isPb = !!e.playbook_id;
        for (let j = i + 1; j < evs.length; j++) {
          if (evs[j].type === 'user_feedback') {
            const ok = ['strong_approve', 'approve'].includes(evs[j].signal) ? 1 : 0;
            if (isPb) { pbT++; pbA += ok; } else { gT++; gA += ok; }
            break;
          }
          if (evs[j].type === 'route_decision') break;
        }
      });
    }
  } catch (_) {}
  return { pbRate: pbT ? pbA / pbT : null, pbT, gRate: gT ? gA / gT : null, gT };
}

function main() {
  let books = [];
  try { books = fs.readdirSync(PB_DIR).filter((f) => /\.jsonc?$/.test(f)); } catch (_) { return console.log('无 playbooks'); }
  // 汇总 trace:playbook 命中轮 → 同会话其后最近的 user_feedback
  const hits = {}; // id -> {uses, approves, rejects, last_used}
  try {
    for (const sid of fs.readdirSync(path.join(ROOT, 'sessions'))) {
      const f = path.join(ROOT, 'sessions', sid, 'trace.jsonl');
      if (!fs.existsSync(f)) continue;
      const evs = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
      evs.forEach((e, i) => {
        if (e.type !== 'route_decision' || !e.playbook_id) return;
        const h = (hits[e.playbook_id] = hits[e.playbook_id] || { uses: 0, approves: 0, rejects: 0, last_used: 0 });
        h.uses++;
        h.last_used = Math.max(h.last_used, Date.parse(e.ts) || 0);
        for (let j = i + 1; j < evs.length; j++) { // 其后最近一次反馈归属本次命中
          if (evs[j].type === 'user_feedback') { if (evs[j].signal === 'strong_approve' || evs[j].signal === 'approve') h.approves++; if (evs[j].signal === 'reject') h.rejects++; break; }
          if (evs[j].type === 'route_decision') break;
        }
      });
    }
  } catch (_) {}

  for (const file of books) {
    const p = path.join(PB_DIR, file);
    let pb;
    try { pb = JSON.parse(fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')); } catch (_) { continue; }
    const h = hits[pb.id] || { uses: 0, approves: 0, rejects: 0, last_used: Date.parse(pb.created_at) || 0 };
    const before = pb.confidence ?? 0.3;
    let conf = before + 0.15 * h.approves - 0.2 * h.rejects; // 复验涨/被否降
    const idleDays = (Date.now() - (h.last_used || Date.parse(pb.created_at) || Date.now())) / 86_400_000;
    if (idleDays > 14) conf -= 0.05 * Math.floor(idleDays / 14); // 闲置衰减
    // §11 基线对比:playbook 认可率持续输给动态基线 → 加速退役;胜出 → 小幅续命(样本 ≥3 才比)
    const bl = globalBaseline();
    if (bl.pbRate !== null && bl.gRate !== null && bl.pbT >= 3) {
      if (bl.pbRate < bl.gRate) { conf -= 0.1; log(`基线对比:playbook 认可率 ${bl.pbRate.toFixed(2)} < 基线 ${bl.gRate.toFixed(2)}(n=${bl.pbT}),-0.1`); }
      else if (bl.pbRate > bl.gRate) { conf += 0.05; }
    }
    conf = Math.max(0, Math.min(1, conf));
    pb.confidence = Number(conf.toFixed(2));
    pb.last_review = { at: new Date().toISOString(), uses: h.uses, approves: h.approves, rejects: h.rejects, idle_days: Math.round(idleDays) };
    if (pb.confidence <= 0.05) {
      fs.renameSync(p, p + '.retired'); // 退役:改名留档,不再被加载(§11「会过期的经验,不是教条」)
      log(`退役 ${pb.id}(${pb.name}) confidence ${before}→${pb.confidence}`);
    } else {
      fs.writeFileSync(p, JSON.stringify(pb, null, 2));
      log(`复验 ${pb.id}(${pb.name}) confidence ${before}→${pb.confidence} uses=${h.uses} approve=${h.approves} idle=${Math.round(idleDays)}d`);
    }
  }
}
main();
