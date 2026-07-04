#!/usr/bin/env node
'use strict';
// DoD①:20 条样例 prompt 的门控分类,输出人工抽查表
const path = require('path');
const { route } = require(path.join(__dirname, '..', 'src', 'lib', 'router'));
const { METHOD_CATALOG, METHOD_COUNT } = require(path.join(__dirname, '..', 'src', 'lib', 'menu'));
const samples = require('./gating-samples.json');

const catalogOk = Object.keys(METHOD_CATALOG).length === 9 && METHOD_COUNT === 69;
console.log(`方法库: ${catalogOk ? '✓' : '✗'} ${Object.keys(METHOD_CATALOG).length} 族 / ${METHOD_COUNT} 法\n`);

let pass = 0;
const rows = samples.map((s) => {
  const r = route(s.prompt);
  const ok = r.mode === s.expected;
  if (ok) pass++;
  return { id: s.id, ok, expected: s.expected, actual: r.mode, intent: r.intent, triggers: r.triggers.join(','), prompt: s.prompt, note: s.note };
});

console.log('| # | 判定 | 期望 | 实际 | 意图 | 触发信号 | prompt |');
console.log('|---|---|---|---|---|---|---|');
for (const r of rows) {
  console.log(`| ${r.id} | ${r.ok ? '✓' : '✗'} | ${r.expected} | ${r.actual} | ${r.intent || '-'} | ${r.triggers || '-'} | ${r.prompt.slice(0, 40)} |`);
}
console.log(`\n${pass}/${samples.length} 符合预期`);
process.exit(pass === samples.length && catalogOk ? 0 : 1);
