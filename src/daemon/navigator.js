'use strict';
// Navigator(§5,Phase 1 形态):七轴机械清单跑 DeepSeek 快档;触发门控不满足就闭嘴(§5.3)
// 禁止(§3.1):不强加目标;不凭记忆裁决事实;目标账本确认机制属 Phase 2,此处账本默认 unconfirmed
const { chat } = require('./deepseek');

const PROXY_WORDS = /流量|曝光|DAU|MAU|GMV|下载量|参与度|互动率|粉丝|阅读量|播放量|点击率|benchmark|涨粉|引流/i;
const COMMITMENT_WORDS = /全部投入|全仓|梭哈|辞职|签约|一次性买断|all[- ]?in|不可逆/i;

const RE_MEANS = /方案|步骤|做法|第一步|建议(你|采用)|应该(先|做)/;

/** 触发门控(§5.3):代理词 | full 决策关口 | 承诺升级 | 答案是手段且终极目标未确认 | /st:altitude 手动。不满足 → null(闭嘴) */
function gate(mode, userPrompt, draft, opts = {}) {
  if (opts.force) return ['manual_altitude'];
  const text = `${userPrompt}\n${draft}`;
  const triggers = [];
  if (opts.staleGoal) triggers.push('goal_confirm_stale'); // §5.3:距上次目标确认 ≥5 轮
  if (opts.patrol) triggers.push('periodic_patrol'); // §5.3:长会话每 N 轮低强度巡检
  if (PROXY_WORDS.test(text)) triggers.push('proxy_word');
  if (mode === 'full') triggers.push('decision_gate');
  if (COMMITMENT_WORDS.test(text)) triggers.push('commitment_escalation');
  if (opts.ledger && opts.ledger.terminal_goal && !opts.ledger.terminal_goal.confirmed && RE_MEANS.test(draft)) {
    triggers.push('means_without_confirmed_goal');
  }
  return triggers.length ? triggers : null;
}

function buildPrompt(userPrompt, draft, ledgerJson) {
  const ledgerBlock = ledgerJson ? `\n【目标账本】(会话累积,目标默认未经用户确认;unconfirmed 的终极目标只能浮现确认,不能当已知)\n${ledgerJson}\n` : '';
  return `你是超限思考系统的 Navigator(对齐副驾)。用户问题与主模型草稿如下。逐轴机械扫描,只报有实据的命中,没有就空数组——门控不满足就闭嘴,你不强加目标,最终措辞由主模型说出。${ledgerBlock}
七轴:goal_traceback(当前动作真推进用户的终极目标吗;注意用户可能只问了代理问题,终极目标未确认)/ proxy_alert(在优化会与真目标分叉的代理指标吗)/ constraint_fit(资源/技能/资金/时间相容)/ environment_fit(法规/平台规则/市场)/ second_order(二阶后果)/ opportunity_cost(这是最优方式还是仅一种战术)/ value_redline(价值红线)。
每条命中给:axis(上述英文名)、severity(major=方向性错配 / minor=值得一提)、issue(一句话,指出具体错配)、ask(供主模型向用户浮现确认的问题,「X 是你要的吗」句式,禁止「你应该要 Y」)。
只输出 JSON:{"flags":[{"axis":"proxy_alert","severity":"major","issue":"...","ask":"..."}]}

【用户问题】${String(userPrompt || '').slice(0, 1500)}
【草稿】${String(draft || '').slice(0, 5000)}`;
}

/**
 * @param {{ledger?:object, force?:boolean, timeoutMs?:number}} opts
 * @returns {Promise<{flags:Array, usage:object|null}>} 失败/未触发 → flags:[]
 */
async function run(mode, userPrompt, draft, cfg, opts = {}) {
  const triggers = gate(mode, userPrompt, draft, opts);
  if (!triggers) return { flags: [], triggers: null, usage: null };
  const ledgerJson = opts.ledger ? require('./ledger').render(opts.ledger) : null;
  const res = await chat(buildPrompt(userPrompt, draft, ledgerJson), cfg.deepseek, { timeoutMs: opts.timeoutMs || 45_000, maxTokens: 2400 });
  if (!res) return { flags: [], triggers, usage: null };
  try {
    // v4 推理模型:JSON 应在 content,被推理挤空时兜底查 reasoning_content
    const text = [res.content, res.reasoning].find((t) => t && t.includes('{')) || '';
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    const parsed = JSON.parse(text.slice(start, end + 1));
    const flags = Array.isArray(parsed.flags) ? parsed.flags.filter((f) => f && f.axis && f.issue) : [];
    return { flags, triggers, usage: res.usage };
  } catch (_) {
    return { flags: [], triggers, usage: res.usage };
  }
}

module.exports = { run, gate };
