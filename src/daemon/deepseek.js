'use strict';
// DeepSeek 异步客户端(Phase 1,既定引擎:OpenAI 兼容直连;pi-ai 留待 Phase 2 panel)
// 模型 ID 实测(2026-07-03):deepseek-v4-flash(快档)/ deepseek-v4-pro(强档);v4 系带 reasoning_content

/**
 * @param {string} prompt
 * @param {{base_url:string,api_key:string,model:string}} ds cfg.deepseek
 * @param {{timeoutMs?:number,maxTokens?:number,model?:string}} opts
 * @returns {Promise<{content:string,reasoning:string,usage:object,duration_ms:number}|null>} 失败=null(调用方降级)
 */
async function chat(prompt, ds, opts = {}) {
  if (!ds || !ds.api_key) return null;
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 60_000);
  try {
    const res = await fetch(`${ds.base_url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ds.api_key}` },
      body: JSON.stringify({
        model: opts.model || ds.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: opts.maxTokens || 4000,
        // v4 推理控制(2026-07-04 实测均被 API 接受):thinking:false=关推理(快查用);reasoningEffort=low(机械提取用)
        ...(opts.thinking === false ? { thinking: { type: 'disabled' } } : {}),
        ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
    return {
      content: msg.content || '',
      reasoning: msg.reasoning_content || '',
      usage: data.usage || null,
      duration_ms: Date.now() - t0,
    };
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 探活(启动 validate_on_start 用):3s 内 /models 可达且含配置模型 */
async function ping(ds) {
  if (!ds || !ds.api_key) return { ok: false, reason: 'no_api_key' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3_000);
  try {
    const res = await fetch(`${ds.base_url.replace(/\/$/, '')}/models`, {
      headers: { Authorization: `Bearer ${ds.api_key}` },
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    const data = await res.json();
    const ids = (data.data || []).map((m) => m.id);
    return { ok: true, models: ids, model_listed: ids.includes(ds.model) };
  } catch (_) {
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { chat, ping };
