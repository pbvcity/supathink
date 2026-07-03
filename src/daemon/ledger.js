'use strict';
// 目标账本(§5.1,Phase 2):会话状态的一部分;目标默认 unconfirmed——Navigator 的职责是浮现让用户确认,不是替用户假设
// Phase 2 形态:启发式捕获 + Navigator 注入;更强的确认协议(显式问答绑定)留给后续

function init() {
  return {
    terminal_goal: { text: null, confirmed: false },
    intermediate: [],
    current_action: { text: null, linked_to: null },
    user_constraints: [],
    context_constraints: [],
  };
}

const RE_TERMINAL = /(终极|最终|真正)(的)?(目标|目的|想要的)(是|就是)([^,。;\n]{2,60})|我做这个(是)?为了([^,。;\n]{2,60})/;
const RE_INTERMEDIATE = /我(想|要|打算|希望)([^,。;\n]{2,40})|目标是([^,。;\n]{2,60})/;
const RE_CONSTRAINT = /(预算|资金|时间|人手|只有|不能超过|最多)([^,。;\n]{2,40})/;
const RE_CONFIRM = /(对|是的|没错)[,,]?\s*(终极)?目标(就是|确实是)|目标确认/;

/** 每个激活轮调用:从用户输入启发式更新账本(全部 unconfirmed 起步) */
function update(ledger, userPrompt) {
  const l = ledger || init();
  const t = String(userPrompt || '');
  const term = t.match(RE_TERMINAL);
  if (term) {
    l.terminal_goal = { text: (term[5] || term[7] || '').trim(), confirmed: false };
  }
  if (RE_CONFIRM.test(t) && l.terminal_goal.text) l.terminal_goal.confirmed = true;
  const inter = t.match(RE_INTERMEDIATE);
  if (inter) {
    const text = (inter[2] || inter[3] || '').trim();
    if (text && !l.intermediate.some((i) => i.text === text)) {
      l.intermediate.push({ id: `i${l.intermediate.length + 1}`, text, serves_terminal: 'unverified' });
      if (l.intermediate.length > 5) l.intermediate.shift();
    }
  }
  const cons = t.match(RE_CONSTRAINT);
  if (cons) {
    const text = cons[0].trim();
    if (!l.user_constraints.includes(text)) { l.user_constraints.push(text); if (l.user_constraints.length > 5) l.user_constraints.shift(); }
  }
  l.current_action = { text: t.slice(0, 120), linked_to: l.intermediate.length ? l.intermediate[l.intermediate.length - 1].id : null };
  return l;
}

function render(ledger) {
  const l = ledger || init();
  return JSON.stringify({
    terminal_goal: l.terminal_goal,
    intermediate: l.intermediate,
    current_action: l.current_action,
    user_constraints: l.user_constraints,
  });
}

module.exports = { init, update, render };
