'use strict';
// 引擎适配层(Phase 2,§10):按模型引用解析到可调用后端;未配置的引擎=不可用(席位自动缺席)
// 不变量(§14.3):扇出禁止使用宿主订阅 → kind:'host' 的引擎不得出现在 panel 席位/judge
const { chat } = require('./deepseek');

async function callOpenAICompat(base, key, model, prompt, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 60_000);
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: opts.temperature ?? 0.3, max_tokens: opts.maxTokens || 2500 }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
    return { content: msg.content || msg.reasoning_content || '', usage: data.usage || null };
  } catch (_) { return null; } finally { clearTimeout(timer); }
}

async function callAnthropicCompat(base, key, model, prompt, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 60_000);
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: opts.maxTokens || 2500, messages: [{ role: 'user', content: prompt }] }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const content = Array.isArray(data.content) ? data.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') : '';
    return { content, usage: data.usage || null };
  } catch (_) { return null; } finally { clearTimeout(timer); }
}

/**
 * 模型引用 → 引擎实例。available=false 的席位由 panel 自动跳过。
 * env 键约定:SUPATHINK_GLM_* / SUPATHINK_MINIMAX_*(BASE_URL/API_KEY/MODEL/COMPAT=openai|anthropic)
 */
function resolveEngine(ref, cfg) {
  const env = cfg.env || {};
  const usable = (k) => k && !/FAKE|REPLACE|CHANGE.?ME/i.test(k);
  if (ref === 'deepseek/flash' || ref === 'deepseek/strong') {
    const model = ref === 'deepseek/strong' ? (env.SUPATHINK_DEEPSEEK_STRONG_MODEL || 'deepseek-v4-pro') : cfg.deepseek.model;
    return {
      ref, provider: 'deepseek', model, kind: 'api',
      available: usable(cfg.deepseek.api_key),
      call: (prompt, opts) => chat(prompt, cfg.deepseek, { ...opts, model }),
    };
  }
  if (ref === 'zhipu/glm' || ref === 'minimax/main') {
    const P = ref === 'zhipu/glm' ? 'GLM' : 'MINIMAX';
    const base = env[`SUPATHINK_${P}_BASE_URL`];
    const key = env[`SUPATHINK_${P}_API_KEY`];
    const model = env[`SUPATHINK_${P}_MODEL`];
    const compat = (env[`SUPATHINK_${P}_COMPAT`] || 'anthropic').toLowerCase(); // OPEN-2:订阅端点通常 Anthropic 兼容
    const caller = compat === 'openai' ? callOpenAICompat : callAnthropicCompat;
    const available = !!(base && usable(key) && model);
    return {
      ref, provider: ref.split('/')[0], model: model || '(未配置)', kind: 'endpoint',
      available,
      call: async (prompt, opts) => {
        if (!available) return null;
        const r = await caller(base, key, model, prompt, opts);
        return r ? { content: r.content, usage: r.usage, duration_ms: null } : null;
      },
    };
  }
  if (ref === 'google/gemini-flash') {
    // OPEN-5:优先 Gemini CLI(OAuth 免费档);无 CLI 但配了 SUPATHINK_GEMINI_API_KEY 则走 REST(v1beta interactions,2026-07 文档形态)
    const { execFile } = require('child_process');
    const hasCli = (() => { try { require('child_process').execSync('which gemini', { stdio: 'pipe' }); return true; } catch (_) { return false; } })();
    const restKey = env.SUPATHINK_GEMINI_API_KEY;
    const restModel = env.SUPATHINK_GEMINI_MODEL || 'gemini-3.5-flash';
    if (hasCli) {
      return {
        ref, provider: 'google', model: 'gemini-flash(cli)', kind: 'subprocess', available: true,
        call: (prompt, opts) => new Promise((resolve) => {
          execFile('gemini', ['-p', prompt], { timeout: (opts && opts.timeoutMs) || 90_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
            resolve(err ? null : { content: String(stdout || ''), usage: null, duration_ms: null });
          });
        }),
      };
    }
    return {
      ref, provider: 'google', model: restModel, kind: 'api', available: usable(restKey),
      call: async (prompt, opts) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), (opts && opts.timeoutMs) || 60_000);
        try {
          const res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': restKey },
            body: JSON.stringify({ model: restModel, input: prompt }),
            signal: ctrl.signal,
          });
          if (!res.ok) return null;
          const data = await res.json();
          const content = data.output_text || (data.output && JSON.stringify(data.output)) || data.text || '';
          return content ? { content: String(content), usage: data.usage || null, duration_ms: null } : null;
        } catch (_) { return null; } finally { clearTimeout(timer); }
      },
    };
  }
  if (ref === 'host') { // 宿主订阅:仅 Proposer/Critic 回退可用,panel/judge 禁用(§14.3)
    return { ref, provider: 'anthropic', model: 'host-subscription', kind: 'host', available: true, call: async () => null };
  }
  return { ref, provider: 'unknown', model: ref, kind: 'unknown', available: false, call: async () => null };
}

module.exports = { resolveEngine };
