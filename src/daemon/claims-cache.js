'use strict';
// claims-cache(§4.2/§9.5):键=归一化断言哈希;条目 {hash, claim_text, verdict, source, checked_at, ttl_days}
// 文件 ~/.supathink/claims-cache/<proj>.jsonl,追加写;读时取同 hash 最新一条并过滤过期
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DIR = path.join(os.homedir(), '.supathink', 'claims-cache');
const TTL_DEFAULT_DAYS = 7;
const TTL_TIMELY_DAYS = 1; // 时效性断言(最新/当前/今年 等)

function normalize(text) {
  return String(text || '').toLowerCase().replace(/[\s,，.。;；:：!！?？、"'「」『』《》()（）\[\]]+/g, '');
}
function claimHash(text) {
  return crypto.createHash('sha256').update(normalize(text)).digest('hex').slice(0, 24);
}
function isTimely(text) {
  return /最新|当前|现在|今年|本月|本周|latest|current|this (year|month|week)/i.test(String(text || ''));
}
function projSlug(cwd) {
  return String(cwd || 'unknown').replace(/[\/\\]/g, '-').replace(/^-+/, '') || 'unknown';
}

function load(cwd) {
  const file = path.join(DIR, projSlug(cwd) + '.jsonl');
  const map = new Map();
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        map.set(e.hash, e); // 后写覆盖先写 → 最新生效
      } catch (_) { /* 坏行跳过 */ }
    }
  } catch (_) { /* 无缓存文件 */ }
  return { file, map };
}

function get(cache, claimText) {
  const fresh = (entry) => {
    const ageDays = (Date.now() - Date.parse(entry.checked_at)) / 86_400_000;
    return ageDays <= (entry.ttl_days || TTL_DEFAULT_DAYS);
  };
  const e = cache.map.get(claimHash(claimText));
  if (e && fresh(e)) return e;
  const needle = normalize(claimText);
  if (needle.length >= 12) {
    for (const entry of cache.map.values()) {
      if (entry.verdict !== 'supported' || !entry.claim_text || !fresh(entry)) continue;
      const hay = normalize(entry.claim_text);
      if (hay.length >= 12 && (hay.includes(needle) || needle.includes(hay))) return entry;
    }
  }
  if (!e) return null;
  return null; // 过期视同未核验
}

function put(cache, claimText, verdict, source) {
  const e = {
    hash: claimHash(claimText),
    claim_text: String(claimText || '').slice(0, 500),
    verdict,
    source: source || null,
    checked_at: new Date().toISOString(),
    ttl_days: isTimely(claimText) ? TTL_TIMELY_DAYS : TTL_DEFAULT_DAYS,
  };
  cache.map.set(e.hash, e);
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(cache.file, JSON.stringify(e) + '\n');
  } catch (_) { /* 缓存写失败不影响主流程 */ }
  return e;
}

module.exports = { load, get, put, claimHash, projSlug };
