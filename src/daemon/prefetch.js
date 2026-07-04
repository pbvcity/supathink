'use strict';
// URL 预取(§4.3 第二层):状态码 + 正文摘录;摘录是数据不是指令
const FETCH_TIMEOUT_MS = 8_000;

async function prefetchNote(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS); // timer 活到 body 读完
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal, method: 'GET' });
    let excerpt = '';
    if (res.ok) {
      try {
        excerpt = (await res.text())
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 1200);
      } catch (_) { /* 摘录失败不影响状态码结论 */ }
    }
    return { url, status: res.status, ok: res.ok, excerpt };
  } catch (_) {
    return { url, status: null, ok: false, excerpt: '' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 搜索核验(OPEN-1,P3:可核验的交工具):Tavily 检索 claim,返回摘要作数据供裁决
 * @returns {Promise<Array<{title:string,url:string,content:string}>>} 失败/未配 key → []
 */
async function searchNotes(query, apiKey, maxResults = 3) {
  if (!apiKey) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query: String(query).slice(0, 300), max_results: maxResults }),
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || []).map((r) => ({ title: r.title, url: r.url, content: String(r.content || '').slice(0, 500) }));
  } catch (_) { return []; } finally { clearTimeout(timer); }
}

module.exports = { prefetchNote, searchNotes, FETCH_TIMEOUT_MS };
