'use strict';
// 能力清单(§10):默认清单 + 用户覆盖 ~/.supathink/capabilities.jsonc;启动/panel 前校验不变量
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULTS = {
  device: { id: 'us-dev', region: 'us' },
  roles: {
    proposer: { model: 'host' },
    critic: { model: 'deepseek/flash', fallback: ['host'] }, // host 回退 = 用户批示的 haiku 路径
    navigator: { model: 'deepseek/flash', fallback: ['google/gemini-flash'] },
    panel_strategist: { model: 'deepseek/strong' },
    // 怀疑席:用户弃用 Gemini(OAuth 档不认订阅,2026-07-03 批示)→ 主绑 deepseek 强档,Gemini 留作回退可选
    panel_skeptic: { model: 'deepseek/strong', fallback: ['google/gemini-flash'] },
    panel_cn_expert: { model: 'zhipu/glm' },
    judge: { model: 'minimax/main', distinct_from: 'panel.*' },
  },
  invariants: [
    '授权/危机判断只由 proposer 完成,禁止路由给扇出档',
    'judge 必须异于所有 panel 席位,违反时配置校验报错',
    '扇出禁止使用宿主订阅(critic 回退为用户批示例外)',
  ],
  policy: { validate_on_start: true },
};

function stripJsonc(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function load() {
  const file = path.join(os.homedir(), '.supathink', 'capabilities.jsonc');
  try {
    const user = JSON.parse(stripJsonc(fs.readFileSync(file, 'utf8')));
    return { ...DEFAULTS, ...user, roles: { ...DEFAULTS.roles, ...(user.roles || {}) }, source: file };
  } catch (_) {
    return { ...DEFAULTS, source: 'defaults' };
  }
}

/**
 * 校验不变量(DoD④:judge=席位 的配置必须被拒绝)。
 * @returns {{ok:boolean, errors:string[]}}
 */
function validate(caps, resolveEngine, cfg) {
  const errors = [];
  const seats = Object.entries(caps.roles).filter(([k]) => k.startsWith('panel_'));
  const judgeRef = caps.roles.judge && caps.roles.judge.model;
  if (!judgeRef) errors.push('缺 judge 角色');
  for (const [k, v] of seats) {
    if (judgeRef && v.model === judgeRef) errors.push(`不变量违反:judge(${judgeRef})与席位 ${k} 同模型——judge 必须 distinct 于所有席位`);
  }
  if (resolveEngine) {
    for (const [k, v] of [...seats, ['judge', caps.roles.judge]]) {
      if (!v) continue;
      const eng = resolveEngine(v.model, cfg);
      if (eng.kind === 'host') errors.push(`不变量违反:${k} 使用宿主订阅(扇出禁止,§14.3)`);
    }
  }
  return { ok: !errors.length, errors };
}

module.exports = { load, validate, DEFAULTS };
