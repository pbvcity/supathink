'use strict';
// Playbooks(§11,Phase 3):稀疏有据的覆盖,不是默认剧本;用户认可才捕获
// 优先级链:安全不变量 > 用户显式 slash > 命中 playbook > 动态默认(在 server 的调用顺序里体现)
// 护栏:不能放松不变量;stance_pref 永不预授权教练站位(§6/P8,门每次实时过)
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(os.homedir(), '.supathink', 'playbooks');
const MODE_RANK = { off: 0, light: 1, full: 2 };

// 强认可信号(§11:弱「谢谢」不算)
const RE_STRONG_APPROVE = /太对了|正是我要的|直接采纳|就这么(办|定)|完全正确|说到点子上|perfect,?\s*(do it|exactly)|exactly what i (want|need)/i;

function stripJsonc(t) { return t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); }

function loadAll() {
  const out = [];
  try {
    for (const f of fs.readdirSync(DIR)) {
      if (!/\.jsonc?$/.test(f)) continue;
      try {
        const pb = JSON.parse(stripJsonc(fs.readFileSync(path.join(DIR, f), 'utf8')));
        if (pb && pb.id && pb.match) out.push({ ...pb, _file: f });
      } catch (_) { /* 坏文件跳过 */ }
    }
  } catch (_) { /* 无目录 */ }
  return out;
}

/** 命中:关键词(任一)出现在 prompt。返回命中的 playbook 或 null */
function match(prompt, books) {
  const t = String(prompt || '').toLowerCase();
  for (const pb of books) {
    const kws = (pb.match.keywords || []).filter(Boolean);
    if (kws.length && kws.some((k) => t.includes(String(k).toLowerCase()))) return pb;
  }
  return null;
}

/** 应用配方到路由决策:只允许抬升 mode 与建议 intent;stance 教练位强制剥离(P8) */
function apply(decision, pb) {
  const recipe = pb.recipe || {};
  if (recipe.mode && (MODE_RANK[recipe.mode] || 0) > (MODE_RANK[decision.mode] || 0)) decision.mode = recipe.mode;
  if (recipe.intent && !decision.intent) decision.intent = recipe.intent;
  if (recipe.stance_pref === 'coach') {
    // 硬护栏:playbook 不能预授权教练站位——忽略该偏好,授权门只认本轮实时交权信号
    decision.playbook_stance_dropped = 'coach';
  }
  decision.triggers.push(`playbook:${pb.id}`);
  return decision;
}

function detectSave(text) {
  const t = String(text || '');
  const m = t.match(/^\s*\/st[:\/]playbook-save\s+(\S+)(?:\s+(.+))?/) || t.match(/^\s*SUPATHINK_PLAYBOOK_SAVE=(\S+)(?:\s+(.+))?/);
  return m ? { name: m[1], scope: (m[2] || '此类决策').trim() } : null;
}

/** 认可即捕获(§11):把上一轮已运行配方反解析为角色形式落盘 */
function save(name, scope, recipe, sourcePrompt) {
  fs.mkdirSync(DIR, { recursive: true });
  const id = `pb-${Date.now().toString(36)}`;
  const keywords = [...new Set(
    String(name).split(/[-_\s]+/).concat(String(sourcePrompt || '').match(/[一-鿿]{2,6}|[a-zA-Z]{4,}/g) || [])
  )].slice(0, 6);
  const pb = {
    id,
    name,
    scope, // 匹配范围,用户可随时改宽/收窄(DoD②「范围可编辑」:直接编辑本文件)
    match: { keywords, intent: recipe.intent || null },
    recipe: { mode: recipe.mode || 'full', intent: recipe.intent || null, stance_pref: null }, // stance 永不入配方的授权位
    confidence: 0.3, // 初始低置信;复验涨、闲置衰(Phase 4)
    created_at: new Date().toISOString(),
    note: '认可捕获自动生成;keywords/scope 可手改;删除本文件即退役',
  };
  fs.writeFileSync(path.join(DIR, `${id}.jsonc`), JSON.stringify(pb, null, 2));
  return pb;
}

module.exports = { loadAll, match, apply, detectSave, save, RE_STRONG_APPROVE, DIR };
