#!/usr/bin/env node
'use strict';
// DoD①(Phase 2,唯一不可妥协质量闸):20 例种子集量化 Critic —— precision ≥0.8 且 recall ≥0.6
// 判定口径:positive 用例 = 含人为植入错误,Critic 报 ≥1 条 blocker/major 记 TP,否则 FN;
//          negative 用例 = 干净回答,报 blocker/major 记 FP,否则 TN。
const path = require('path');
const { runCritic } = require(path.join(__dirname, '..', 'src', 'lib', 'critic'));
const { loadConfig } = require(path.join(__dirname, '..', 'src', 'lib', 'config'));
const cases = require('./seedset/cases.json');

const CONCURRENCY = 4;

(async () => {
  const cfg = loadConfig(process.cwd());
  if (cfg.backend !== 'deepseek') { console.log(`当前后端 ${cfg.backend};种子集评估固定走 deepseek`); cfg.backend = 'deepseek'; }
  const results = [];
  let i = 0;
  async function worker() {
    while (i < cases.length) {
      const c = cases[i++];
      const t0 = Date.now();
      let r = await runCritic(c.draft, cfg);
      if (!r) r = await runCritic(c.draft, cfg); // 瞬时失败重试一次(评估的是 Critic 判断力,不是网络)
      const severe = r ? (r.review.annotations || []).filter((a) => a.severity === 'blocker' || a.severity === 'major') : [];
      results.push({ ...c, ok: !!r, flagged: severe.length > 0, severe, ms: Date.now() - t0 });
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  results.sort((a, b) => a.id - b.id);

  let TP = 0, FP = 0, FN = 0, TN = 0, failed = 0;
  console.log('| # | 期望 | Critic | 判定 | 首条严重批注 |');
  console.log('|---|---|---|---|---|');
  for (const r of results) {
    if (!r.ok) { failed++; }
    let cell;
    if (r.positive && r.flagged) { TP++; cell = 'TP ✓'; }
    else if (r.positive && !r.flagged) { FN++; cell = 'FN ✗'; }
    else if (!r.positive && r.flagged) { FP++; cell = 'FP ✗'; }
    else { TN++; cell = 'TN ✓'; }
    console.log(`| ${r.id} | ${r.positive ? '有错' : '干净'} | ${r.flagged ? '举旗' : '放行'} | ${cell} | ${(r.severe[0] && `[${r.severe[0].severity}] ${r.severe[0].issue}`.slice(0, 60)) || '-'} |`);
  }
  const precision = TP + FP ? TP / (TP + FP) : 0;
  const recall = TP + FN ? TP / (TP + FN) : 0;
  console.log(`\nTP=${TP} FP=${FP} FN=${FN} TN=${TN}${failed ? ` (${failed} 例 Critic 调用失败,按未举旗计)` : ''}`);
  console.log(`precision=${precision.toFixed(2)} (闸 ≥0.80) | recall=${recall.toFixed(2)} (闸 ≥0.60)`);
  const pass = precision >= 0.8 && recall >= 0.6;
  try { // 供 supathink stats 面板读取
    require('fs').writeFileSync(require('path').join(require('os').homedir(), '.supathink', 'seedset-last.txt'),
      `precision=${precision.toFixed(2)} recall=${recall.toFixed(2)} @${new Date().toISOString().slice(0, 10)}`);
  } catch (_) {}
  console.log(pass ? 'DoD① 通过' : 'DoD① 未达标 —— 按 §13:先修 Critic 再扩,不得妥协');
  process.exit(pass ? 0 : 1);
})();
