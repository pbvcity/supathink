'use strict';
// Critic 管线(Phase 1):
//  fastCheck  —— light 快查:缓存已证伪断言比对(本地)+ 一次 DeepSeek 结构快查,硬预算 ≤2s,超时=放行(§3.2/§9.6)
//  slowVerify —— light 慢查(异步):提取账本 → 缓存命中跳核验(§4.2)→ URL 预取(带摘录,§4.3)→ 裁决 → 回写缓存
//  fullReview —— full 档单次全审(复用 lib/critic:haiku 走订阅需异步化防塞 daemon 事件循环;deepseek 原生异步)
const { execFile } = require('child_process');
const path = require('path');
const os = require('os');
const { chat } = require('./deepseek');
const cacheLib = require('./claims-cache');
const { buildPrompt, extractJson, extractUrls } = require(path.join(__dirname, '..', 'lib', 'critic'));

const FAST_BUDGET_MS = 2_000; // §9.6:light 快查阻塞 ≤2s

function pickJson(text) { return extractJson(text || ''); }

// ---------- 快查 ----------
async function fastCheck(draft, cfg, cache, budgetMs = FAST_BUDGET_MS) {
  const t0 = Date.now();
  // 1) 缓存命中(本地,~0ms):已证伪断言原文出现在 draft → blocker
  const cachedHits = [];
  for (const e of cache.map.values()) {
    if (e.verdict === 'refuted' && e.claim_text && e.claim_text.length >= 12 && draft.includes(e.claim_text)) {
      cachedHits.push({ issue: `此前已证伪的断言再次出现:「${e.claim_text.slice(0, 60)}」`, claim_text: e.claim_text, cache_hit: true });
    }
  }
  if (cachedHits.length) return { blockers: cachedHits, timed_out: false, ms: Date.now() - t0, usage: null };
  // 2) 结构快查:一次 DeepSeek 调用,剩余预算内硬止
  const remain = budgetMs - (Date.now() - t0) - 50;
  if (remain < 300) return { blockers: [], timed_out: true, ms: Date.now() - t0, usage: null };
  const prompt = `快查主模型草稿,只找 blocker 级问题:具体到可核实却明显可疑的引用(虚构期刊/占位 DOI)、自相矛盾、结论与自身前提相反。不确定的不报。只输出 JSON:{"blockers":[{"issue":"一句话"}]},没有就 {"blockers":[]}。\n--- DRAFT ---\n${String(draft).slice(0, 4000)}`;
  const res = await chat(prompt, cfg.deepseek, { timeoutMs: remain, maxTokens: 400, thinking: false }); // 关推理:2s 预算内出真结论(实测参数,decisions #20)
  if (!res) return { blockers: [], timed_out: true, ms: Date.now() - t0, usage: null }; // 超时/失败=放行(§3.2)
  const parsed = pickJson(res.content) || pickJson(res.reasoning);
  const blockers = parsed && Array.isArray(parsed.blockers) ? parsed.blockers.filter((b) => b && b.issue) : [];
  return { blockers, timed_out: false, ms: Date.now() - t0, usage: res.usage };
}

// ---------- 慢查 ----------
const EXTRACT_PROMPT = (draft) => `从主模型草稿提取 claim 账本(§4.1),四类:fact / citation / assumption / inference。citation 尽量带 ref(URL 或 作者/年份/出处)。只提取,不裁决;text 字段必须原样摘录 draft 中的连续原文片段,禁止改写(缓存按原文哈希命中)。只输出 JSON:
{"claims":[{"id":"c1","type":"fact","text":"...","verifiable":true,"check":"fetch|search|none","ref":"url?"}]}
--- DRAFT ---
${String(draft).slice(0, 8000)}`;

async function prefetchWithCache(urls, cache, trace) {
  // URL 级缓存:同 URL 7 天内取过 → 跳过网络(命中即 §4.2 的「重复命中直接跳过」)
  const { prefetchNote } = require('./prefetch');
  const notes = [];
  for (const url of urls) {
    const hit = cacheLib.get(cache, `URL::${url}`);
    if (hit && hit.source) {
      try { notes.push({ ...JSON.parse(hit.source), cache_hit: true }); continue; } catch (_) { /* 坏缓存重取 */ }
    }
    const note = await prefetchNote(url);
    notes.push({ ...note, cache_hit: false });
    cacheLib.put(cache, `URL::${url}`, note.ok ? 'supported' : 'not_found', JSON.stringify(note));
  }
  return notes;
}

async function slowVerify(draft, userPrompt, cfg, cache) {
  const out = { claims: [], results: [], annotations: [], usage: [] };
  const ext = await chat(EXTRACT_PROMPT(draft), cfg.deepseek, { timeoutMs: 45_000, maxTokens: 5000, reasoningEffort: 'low' }); // 机械提取不需要深推理
  if (!ext) return out;
  if (ext.usage) out.usage.push(ext.usage);
  const parsed = pickJson(ext.content) || pickJson(ext.reasoning);
  const claims = parsed && Array.isArray(parsed.claims) ? parsed.claims : [];
  out.claims = claims;
  const toVerify = [];
  for (const c of claims) {
    if (c.type !== 'fact' && c.type !== 'citation') continue;
    const hit = cacheLib.get(cache, c.text);
    if (hit) {
      out.results.push({ claim_id: c.id, verdict: hit.verdict, source: hit.source, cache_hit: true });
      if (hit.verdict === 'refuted' || hit.verdict === 'not_found') {
        out.annotations.push({ severity: hit.verdict === 'refuted' ? 'blocker' : 'major', claim_id: c.id, issue: `(缓存)${hit.verdict}:${c.text.slice(0, 80)}` });
      }
      continue; // §4.2:命中跳核验
    }
    toVerify.push(c);
  }
  if (!toVerify.length) return out;
  const urls = [...new Set(toVerify.map((c) => c.ref).filter((r) => /^https?:\/\//.test(r || '')).concat(extractUrls(draft)))].slice(0, 3);
  const notes = await prefetchWithCache(urls, cache, null);
  // OPEN-1:fact 类断言走搜索核验(Tavily,配了 key 才启用;每轮最多 2 条,数据非指令)
  const tavilyKey = (cfg.env || {}).SUPATHINK_TAVILY_API_KEY;
  let searchBlocks = [];
  if (tavilyKey) {
    const { searchNotes } = require('./prefetch');
    const factClaims = toVerify.filter((c) => c.type === 'fact' && !/^https?:\/\//.test(c.ref || '')).slice(0, 2);
    searchBlocks = (await Promise.all(factClaims.map(async (c) => ({ claim: String(c.text).slice(0, 120), results: await searchNotes(c.text, tavilyKey) }))))
      .filter((b) => b.results.length);
  }
  const judgePrompt = buildPrompt(String(draft).slice(0, 6000), notes.map((n) => ({ url: n.url, status: n.status, ok: n.ok, excerpt: n.excerpt })), searchBlocks);
  const judged = await chat(judgePrompt, cfg.deepseek, { timeoutMs: 60_000, maxTokens: 8000 });
  if (judged && judged.usage) out.usage.push(judged.usage);
  const review = judged ? (pickJson(judged.content) || pickJson(judged.reasoning)) : null;
  if (review) {
    const byText = new Map((review.claims || []).map((rc) => [cacheLib.claimHash(rc.text || ''), rc]));
    for (const c of toVerify) {
      const rc = byText.get(cacheLib.claimHash(c.text)) || (review.claims || []).find((x) => x.id === c.id);
      const verdict = rc && ['supported', 'refuted', 'not_found', 'skipped'].includes(rc.verdict) ? rc.verdict : 'skipped';
      out.results.push({ claim_id: c.id, verdict, source: (rc && rc.ref) || null, cache_hit: false });
      if (verdict !== 'skipped') cacheLib.put(cache, c.text, verdict, (rc && rc.ref) || null); // skipped 不入缓存,下次仍查
    }
    for (const a of review.annotations || []) out.annotations.push(a);
  }
  return out;
}

// ---------- full 档全审 ----------
function runHaikuAsync(draft, timeoutMs) {
  return new Promise((resolve) => {
    const workDir = path.join(os.homedir(), '.supathink', 'critic-work');
    try { require('fs').mkdirSync(workDir, { recursive: true }); } catch (_) {}
    const t0 = Date.now();
    const child = execFile('claude', ['-p', '--model', 'haiku', '--output-format', 'json', '--allowedTools', 'WebFetch'], {
      cwd: workDir,
      env: { ...process.env, SUPATHINK_CRITIC: '1' },
      timeout: timeoutMs || 90_000,
      maxBuffer: 8 * 1024 * 1024,
    }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const outer = JSON.parse(stdout);
        const review = pickJson(typeof outer.result === 'string' ? outer.result : '');
        if (!review || !review.verdict) return resolve(null);
        resolve({ review, usage: { backend: 'haiku', model: 'haiku', duration_ms: Date.now() - t0, usage: outer.usage || null, total_cost_usd: outer.total_cost_usd ?? null } });
      } catch (_) { resolve(null); }
    });
    child.stdin.end(buildPrompt(draft, null));
  });
}

async function fullReview(draft, cfg, opts = {}) {
  if (process.env.SUPATHINK_TEST_ALWAYS_BLOCK === '1') { // DoD② 对抗桩:永远给 blocker,验证循环上限不死循环
    return { review: { verdict: 'block', claims: [], annotations: [{ id: 'a1', severity: 'blocker', issue: '测试桩:永远拦截' }] }, usage: { backend: 'stub', model: 'stub', duration_ms: 0 } };
  }
  if (cfg.backend === 'deepseek') {
    const { runCritic } = require(path.join(__dirname, '..', 'lib', 'critic'));
    return runCritic(draft, cfg, opts); // deepseek 路径原生异步
  }
  return runHaikuAsync(draft, 80_000); // haiku 走订阅,异步化防塞事件循环;80s < hook 90s(§9.2),留响应余量
}

module.exports = { fastCheck, slowVerify, fullReview, FAST_BUDGET_MS };
