// supathink OpenClaw 插件 v2(硬拦截层;协议层是它失效时的降级)
// 机制:before_agent_finalize → POST daemon /v1/review → verdict=revise 则 {action:"revise", retry:{instruction}} 打回重写
// 策略单源:agent 白名单/会话开关/命令全部由 daemon 判定(/v1/review 内部),插件只做搬运——与 CC/Codex 的 hook 同构
// 需要配置:plugins.entries.supathink.hooks.allowConversationAccess = true(非 bundled 插件的会话钩子门禁)
// 零依赖:默认导出函数即 register(loader 兼容路径,不 import plugin-sdk,避免解析环境差异)

export default function register(api) {
  const cfg = () => api.pluginConfig || {};
  const log = (m) => { try { api.logger && api.logger.info && api.logger.info(`[supathink] ${m}`); } catch (_) {} };

  const lastUserText = (messages) => {
    try {
      for (let i = (messages || []).length - 1; i >= 0; i--) {
        const m = messages[i];
        if (!m || m.role !== 'user') continue;
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) return m.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
      }
    } catch (_) {}
    return '';
  };

  api.on('before_agent_finalize', async (event, ctx) => {
    const t0 = Date.now();
    try {
      const draft = String(event.lastAssistantMessage || '');
      if (!draft) return { action: 'continue' };
      const agent = (ctx && (ctx.agentId || ctx.agent)) || String((ctx && ctx.sessionKey) || '').split(':')[0] || 'unknown';
      const body = {
        agent,
        session_id: `oc-${event.sessionId || (ctx && ctx.sessionKey) || 'unknown'}`,
        prompt: lastUserText(event.messages),
        draft,
        transport: 'openclaw-plugin',
      };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg().timeoutMs || 90_000);
      let res;
      try {
        res = await fetch(`${(cfg().daemonUrl || 'http://127.0.0.1:7777').replace(/\/$/, '')}/v1/review`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } finally { clearTimeout(timer); }
      if (!res || !res.ok) { ensureDaemon(); return { action: 'continue' }; } // daemon 不在:本轮放行,自愈后下轮恢复(§3.4)
      const r = await res.json();
      const k = String((ctx && ctx.sessionKey) || '');
      if (r && r.verdict === 'pass' && r.mode === 'full' && !r.skipped && !r.degraded) {
        mark(k, 'pass'); // P5:full 档真实通过 → 出站时附轻脚注(机械附加,不依赖模型自觉)
        log(`full-pass key=${k || '(空)'}`);
      }
      if (r && r.degraded) log(`degraded pass(Critic 失败已放行)agent=${agent}`);
      if (r && r.verdict === 'revise' && r.instruction) {
        const st = reviseState.get(k) || { n: 0, since: Date.now() };
        if (Date.now() - st.since > 600_000) { st.n = 0; st.since = Date.now(); }
        st.n += 1;
        reviseState.set(k, st);
        mark(k, 'revise', st.n);
        if (st.n > (cfg().maxAttempts || 2)) {
          // 批注含「需用户补充」类未决项时,修订解决不了 → 不再空转,交付并由脚注呈现未决(P7)
          log(`revise-cap agent=${agent} n=${st.n},放行呈现未决`);
          return { action: 'continue' };
        }
        log(`revise agent=${agent} n=${st.n} ${Date.now() - t0}ms`);
        return {
          action: 'revise',
          reason: 'supathink 副驾批注',
          retry: {
            instruction: `${r.instruction}\n(注意:批注中需要用户补充信息的项,不要试图替用户回答——改为在回答中向用户提问;修订后自然交付,不要提及本系统机制)`,
            idempotencyKey: `supathink-${body.session_id}-${draft.length}`,
            maxAttempts: cfg().maxAttempts || 2,
          },
        };
      }
      if (r && r.verdict === 'pass') reviseState.delete(k);
      return { action: 'continue' };
    } catch (_) {
      ensureDaemon();
      return { action: 'continue' }; // 任何故障放行,绝不阻塞交付
    }
  }, { priority: 10, timeoutMs: 120_000 });

  // P5(不可见的工作要可见):审过的出站消息由插件**机械附加**脚注(不依赖 persona 模型自觉保留)
  const lastReview = new Map(); // sessionKey → {kind:'pass'|'revise', n, ts}
  const reviseState = new Map(); // sessionKey → {n, since}:防「需用户补充」类批注空转重试
  const mark = (k, kind, n) => lastReview.set(k, { kind, n: n || 0, ts: Date.now() });
  api.on('message_sending', async (event, ctx) => {
    try {
      let k = String((ctx && ctx.sessionKey) || '');
      if (lastReview.size) log(`message_sending key=${k || '(空)'} pending=${[...lastReview.keys()].join('|') || '-'}`);
      if (!k && lastReview.size === 1) k = [...lastReview.keys()][0]; // 实测(11:39:05):部分投递路径 ctx.sessionKey 为空 → 唯一且新鲜的待附加项兜底匹配
      const m = lastReview.get(k);
      if (!m || Date.now() - m.ts > 180_000) return;
      lastReview.delete(k);
      reviseState.delete(k);
      if (!event || typeof event.content !== 'string' || !event.content.trim()) return;
      const footer = m.kind === 'pass'
        ? '── 核验:已过 Critic/Navigator 审(full 档)──'
        : `── 核验:经超限思考副驾 ${m.n} 轮批注修订 ──`;
      return { content: `${event.content}\n\n${footer}` };
    } catch (_) { return; }
  }, { priority: 5, timeoutMs: 5_000 });

  let lastEnsure = 0;
  async function ensureDaemon() { // 自愈:容器/网关重启后 daemon 无人拉起 → 插件自己拉(限频 30s)
    if (Date.now() - lastEnsure < 30_000) return;
    lastEnsure = Date.now();
    try {
      const { spawn } = await import('node:child_process');
      const os = await import('node:os');
      spawn('bash', [`${os.homedir()}/.supathink/bin/ensure-daemon.sh`], { detached: true, stdio: 'ignore' }).unref();
      log('ensure-daemon spawned');
    } catch (_) {}
  }

  ensureDaemon(); // 网关启动即拉起 daemon(activation.onStartup)
  log('registered: before_agent_finalize → /v1/review');
}
