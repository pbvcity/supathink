// supathink OpenClaw 插件 v3(双段式,与 CC/Codex 同构;协议层是它失效时的降级)
// 生成前 before_prompt_build → POST /v1/hook/precmd:命令在 agent 张嘴前即时生效 + 注入指令(prependContext),
//   agent 下一句即干净确认——不再让 persona 对着裸命令(/ston 等)瞎猜(这是 OpenClaw 唯有交付后钩子时的老坑)。
// 生成后 before_agent_finalize → POST /v1/review:verdict=revise 则 {action:"revise", retry:{instruction}} 打回重写。
// 出站 message_sending → 机械附加 full/revise 核验脚注(P5),不依赖 agent 自觉保留。
// 策略单源:命令识别/会话开关/agent 白名单全部由 daemon 判定(/v1/*),插件只做搬运。两钩子用同一 ctx.sessionId 派生 sid,
//   保证生成前写入的会话状态(session_auto 等)生成后读得到(OpenClaw hook 契约:before_prompt_build 的 event 无 sessionId,
//   会话身份只在 ctx;两侧统一走 ctx.sessionId 消除错配)。
// 需要配置:plugins.entries.supathink.hooks.allowConversationAccess = true(会话钩子门禁)。零依赖(默认导出即 register)。

export default function register(api) {
  const cfg = () => api.pluginConfig || {};
  const log = (m) => { try { api.logger && api.logger.info && api.logger.info(`[supathink] ${m}`); } catch (_) {} };

  // 三钩子一致的会话 id:统一优先 ctx.sessionId → ctx.sessionKey(buildAgentHookContext 给所有钩子都注入这两者),
  // event.sessionId 仅 finalize 独有,放最后兜底——保证 before_prompt_build/finalize/message_sending 在 ctx.sessionId
  // 缺失时也退化到同一个 ctx.sessionKey,不会分叉(评审 sid-consistency 项)。
  const sidOf = (event, ctx) =>
    `oc-${(ctx && ctx.sessionId) || (ctx && ctx.sessionKey) || (event && event.sessionId) || 'unknown'}`;
  const agentOf = (ctx) => (ctx && (ctx.agentId || ctx.agent)) || String((ctx && ctx.sessionKey) || '').split(':')[0] || 'unknown';
  const cwdOf = (ctx) => (ctx && (ctx.workspaceDir || ctx.cwd)) || '';

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

  // OpenClaw 部分 agent 模式(Delivery/工具投递)把整段「Delivery:…元数据…Conversation context #NNN…\n\n<当前消息>」作为 prompt 传入。
  // 真实当前用户消息在尾部;历史命令在 context 里(不能全局扫,否则误命中旧 /ston)。提取尾段:最后一个 #NNN 上下文行 或 ``` 围栏之后的内容。
  const latestUserMsg = (event) => {
    let raw = String((event && event.prompt) || '') || lastUserText(event && event.messages);
    if (!/^\s*Delivery:/.test(raw) && !/Conversation (info|context) \(untrusted/.test(raw)) return raw; // 非包装:原样
    const lines = raw.split('\n');
    let cut = -1;
    for (let i = 0; i < lines.length; i++) if (/^#\d+\s/.test(lines[i]) || lines[i].trim() === '```') cut = i;
    return lines.slice(cut + 1).join('\n').trim() || raw;
  };

  const daemonUrl = () => (cfg().daemonUrl || 'http://127.0.0.1:7777').replace(/\/$/, '');
  async function postDaemon(pathname, body, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || cfg().timeoutMs || 90_000);
    try {
      const res = await fetch(`${daemonUrl()}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res || !res.ok) return null;
      return await res.json();
    } catch (_) {
      return null;
    } finally { clearTimeout(timer); }
  }

  // ── 生成前:命令拦截 + 上下文注入(CC UserPromptSubmit 的 OpenClaw 等价物)──
  const precmdOk = new Map(); // sid → ts:本轮生成前 onPrecmd 确已在 daemon 跑过 → finalize 据此告知 onReview 不必再兜底补处理命令
  const pendingDeliveryAck = new Map(); // sid → ts:后台结果已注入为强制可见交付任务,下一条 message_sending 需回报 daemon
  const pruneMap = (m, ttlMs) => {
    for (const [key, ts] of m) if (Date.now() - ts > ttlMs) m.delete(key);
  };
  api.on('before_prompt_build', async (event, ctx) => {
    try {
      const k = sidOf(event, ctx);
      pruneMap(precmdOk, 120_000); // 清 finalize 未消费的陈旧标记
      pruneMap(pendingDeliveryAck, 600_000);
      const prompt = latestUserMsg(event); // 从 Delivery 包装里取当前用户消息(否则命令检测拿到的是整段元数据 blob)
      if (!prompt) return;
      const r = await postDaemon('/v1/hook/precmd', { session_id: k, cwd: cwdOf(ctx), prompt, host: 'openclaw', agent: agentOf(ctx) }, 20_000);
      if (!r) { ensureDaemon(); return; } // daemon 不在:precmd 未跑(finalize 不置 precmd_ran → onReview 兜底补处理),自愈后恢复
      precmdOk.set(k, Date.now());
      if (r.requiresVisibleDelivery) pendingDeliveryAck.set(k, Date.now());
      if (r.additionalContext) {
        log(`precmd inject key=${k}`);
        return { prependContext: r.additionalContext }; // harness 将其 prepend 进 prompt(实测契约)
      }
    } catch (_) { ensureDaemon(); }
  }, { priority: 10, timeoutMs: 25_000 });

  // ── 生成后:双轴审稿 → revise 打回 ──
  const reviseState = new Map(); // sessionKey → {n, since}:防「需用户补充」类批注空转重试
  api.on('before_agent_finalize', async (event, ctx) => {
    const t0 = Date.now();
    try {
      const draft = String(event.lastAssistantMessage || '');
      const k = sidOf(event, ctx);
      const userMsg = latestUserMsg(event); // 从 Delivery 包装取当前用户消息(与 bpb 同源)
      if (!draft) return { action: 'continue' };
      const agent = agentOf(ctx);
      const ranTs = precmdOk.get(k); // 本轮生成前 onPrecmd 是否确已跑过(否则让 onReview 兜底补处理元命令,防 daemon 自愈窗内静默吞命令)
      const precmdRan = !!(ranTs && Date.now() - ranTs < 120_000);
      precmdOk.delete(k);
      const r = await postDaemon('/v1/review', {
        agent,
        session_id: k,
        prompt: userMsg,
        draft,
        cwd: cwdOf(ctx),
        transport: 'openclaw-plugin',
        precmd_ran: precmdRan,
      });
      if (!r) { ensureDaemon(); return { action: 'continue' }; } // daemon 不在:本轮放行(§3.4)
      if (r.verdict === 'pass' && r.mode === 'full' && !r.skipped && !r.degraded) {
        mark(k, 'pass'); // P5:full 档真实通过 → 出站时附轻脚注(机械附加,不依赖模型自觉)
        log(`full-pass key=${k}`);
      }
      if (r.degraded) log(`degraded pass(Critic 失败已放行)agent=${agent}`);
      if (r.verdict === 'revise' && r.instruction) {
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
            idempotencyKey: `supathink-${k}-${draft.length}`,
            maxAttempts: cfg().maxAttempts || 2,
          },
        };
      }
      if (r.verdict === 'pass') reviseState.delete(k);
      return { action: 'continue' };
    } catch (_) {
      ensureDaemon();
      return { action: 'continue' }; // 任何故障放行,绝不阻塞交付
    }
  }, { priority: 10, timeoutMs: 120_000 });

  // P5(不可见的工作要可见):审过的出站消息由插件**机械附加**脚注(不依赖 persona 模型自觉保留)
  const lastReview = new Map(); // sessionKey → {kind:'pass'|'revise', n, ts}
  const mark = (k, kind, n) => lastReview.set(k, { kind, n: n || 0, ts: Date.now() });
  api.on('message_sending', async (event, ctx) => {
    try {
      for (const [key, v] of lastReview) if (Date.now() - v.ts > 180_000) lastReview.delete(key); // 先清过期,防陈旧项堆积
      pruneMap(pendingDeliveryAck, 600_000);
      const k = sidOf(event, ctx); // 与 mark() 写入键同构(均经 sidOf)——只认精确匹配;身份缺失时宁可不贴脚注,也不靠 size===1 兜底跨会话错贴(评审 footer-misattrib 项)
      if (lastReview.size) log(`message_sending key=${k} pending=${[...lastReview.keys()].join('|') || '-'}`);
      const m = lastReview.get(k);
      if (!event || typeof event.content !== 'string') return;
      let content = event.content;
      if (m && Date.now() - m.ts <= 180_000) {
        lastReview.delete(k);
        reviseState.delete(k);
        const footer = m.kind === 'pass'
          ? '── 核验:已过 Critic/Navigator 审(full 档)──'
          : `── 核验:经超限思考副驾 ${m.n} 轮批注修订 ──`;
        content = `${content}\n\n${footer}`;
      }
      if (pendingDeliveryAck.has(k)) {
        const ack = await postDaemon('/v1/hook/message-sent', { session_id: k, content: content.slice(0, 16000), host: 'openclaw' }, 1500);
        if (ack && ack.pending > 0) pendingDeliveryAck.set(k, Date.now());
        else if (ack) pendingDeliveryAck.delete(k);
      }
      if (!content.trim()) return;
      if (content !== event.content) return { content };
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
  log('registered: before_prompt_build → /v1/hook/precmd; before_agent_finalize → /v1/review; message_sending → review footer');
}
