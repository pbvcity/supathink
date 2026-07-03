'use strict';
// 资源底座与激活配置(Phase 0.5)
// 解析链:项目级 <cwd>/.supathink.json > 用户级 ~/.supathink/env > 内置默认(auto=false)
// 激活模型:默认关;auto=true 时 Router 仍按需分档(不是全开);/slow /fast 命令必开/必关,不受 auto 限制
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(os.homedir(), '.supathink');

function parseEnvFile(file) {
  const out = {};
  try {
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch (_) { /* 无 env 文件 → 全默认 */ }
  return out;
}

/**
 * @param {string} cwd hook payload 的 cwd(项目级配置按此查找)
 * @returns {{auto:boolean, backend:string, deepseek:{base_url:string,api_key:string,model:string}, env:object, project:object|null}}
 */
function loadConfig(cwd) {
  const env = parseEnvFile(path.join(ROOT, 'env'));
  let project = null;
  try {
    project = JSON.parse(fs.readFileSync(path.join(cwd || '', '.supathink.json'), 'utf8'));
  } catch (_) { /* 项目未配置 */ }

  const auto = project && typeof project.auto === 'boolean'
    ? project.auto
    : env.SUPATHINK_AUTO === 'true';
  // 快审后端:显式配置优先;未配置/auto = 有可用 DeepSeek key 就用 deepseek(3–6s),否则回退宿主快模型 haiku
  const dsKey = env.SUPATHINK_DEEPSEEK_API_KEY || '';
  const dsUsable = dsKey && !/FAKE|REPLACE|CHANGE.?ME/i.test(dsKey);
  let backend = (project && project.critic_backend) || env.SUPATHINK_CRITIC_BACKEND || 'auto';
  if (backend === 'auto') backend = dsUsable ? 'deepseek' : 'haiku';

  return {
    auto,
    backend,
    deepseek: {
      base_url: env.SUPATHINK_DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
      api_key: env.SUPATHINK_DEEPSEEK_API_KEY || '',
      model: env.SUPATHINK_DEEPSEEK_MODEL || 'deepseek-chat',
    },
    env,
    project,
  };
}

/**
 * 用户命令必开/必关:/st:slow(本轮 full)、/st:fast(本轮跳过);兼容旧名 /slow /fast。
 * 兼容两种到达形态:原始「/st:slow …」前缀,或命令展开后位于 prompt 起始的「SUPATHINK_FORCE=…」标记。
 * 两种形态都只认 prompt 开头(评审 F2/F12:正文中粘贴的标记是数据不是指令,不得进入控制位;
 * 命令前缀优先于标记,保证「/st:slow 分析 SUPATHINK_FORCE=off …」仍必开)。
 * @returns {'full'|'off'|null}
 */
function detectSlowFull(text) { // /st:slow-full:full + Proposer 自出账本(§4.1)
  const t = String(text || '');
  return /^\s*\/st[:\/]slow-full\b/.test(t) || /^\s*SUPATHINK_FORCE=full-ledger\b/.test(t);
}

function detectForce(text) {
  const t = String(text || '');
  if (detectSlowFull(t)) return 'full';
  const cmd = t.match(/^\s*\/(?:st[:\/])?(slow|fast)\b/);
  if (cmd) return cmd[1] === 'fast' ? 'off' : 'full';
  const mark = t.match(/^\s*SUPATHINK_FORCE=(full|off)\b/);
  if (mark) return mark[1];
  return null;
}

/**
 * 会话级开关:/st:on /st:off(或命令展开标记 SUPATHINK_SESSION=on|off);只认 prompt 开头。
 * 效果写入 session state(session_auto),优先级:本轮命令 > 会话开关 > 项目 > 用户 env > 默认关。
 * @returns {'on'|'off'|null}
 */
function detectSessionToggle(text) {
  const t = String(text || '');
  const m = t.match(/^\s*\/st[:\/](on|off)\b/) || t.match(/^\s*SUPATHINK_SESSION=(on|off)\b/);
  return m ? m[1] : null;
}

/** 多模型工作流命令(§8,Phase 2 范围仅 panel/panel-lite/altitude):只认 prompt 开头 */
function detectPanel(text) {
  const t = String(text || '');
  const slash = t.match(/^\s*\/st[:\/](panel-lite|panel|debate|delphi|redblue)\b/);
  if (slash) return slash[1] === 'panel-lite' ? 'lite' : slash[1];
  const mark = t.match(/^\s*SUPATHINK_PANEL=(panel|lite|debate|delphi|redblue)\b/);
  return mark ? (mark[1] === 'lite' ? 'lite' : mark[1]) : null;
}
function detectAltitude(text) {
  const t = String(text || '');
  return /^\s*\/st[:\/]altitude\b/.test(t) || /^\s*SUPATHINK_ALTITUDE=1\b/.test(t);
}

/** 北极星标记(§16):聊天内 /st:win(同义 /st:star)——用户判定某次拦截真实救场 */
function detectWin(text) {
  const t = String(text || '');
  const m = t.match(/^\s*\/st[:\/](?:win|star)\b(.*)$/s) || t.match(/^\s*SUPATHINK_WIN=1\s*(.*)$/s);
  if (!m) return null;
  return { desc: String(m[1] || '').trim().slice(0, 300) || '用户标记(未附描述)' };
}

module.exports = { ROOT, loadConfig, detectForce, detectSlowFull, detectSessionToggle, detectPanel, detectAltitude, detectWin, parseEnvFile };
