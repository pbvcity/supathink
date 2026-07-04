'use strict';
// Router(§3.1/§3.2):纯规则门控 verification_mode ∈ {off, light, full} + 意图→菜单 + 教练门检测(§6,Phase 0 仅此一项站位功能)
// 判错代价不对称:漏升级=维持现状,误升级=一次廉价检查 → 规则版足够起步(§3.2)

const { pickMenu } = require('./menu');

// —— full 触发:决策语气 / 不可逆承诺 / 交权信号(§3.2 门控信号 + §6 教练门)——
const RE_DECISION = [
  /该不该|要不要|应不应该|应该.{0,8}吗|值不值得|值得.{0,6}吗|划算吗/,
  /选哪个|哪个更|哪个(好|合适|靠谱|划算)|怎么选|如何(选择|取舍)|帮我(选|挑)|二选一|取舍|权衡一下/,
  /做?决定|拍板|定夺|敲定|拿主意/,
  /还是.{0,24}[?？]\s*$/, // 「A 还是 B?」句式
  /(应该|应当|该|要(?!是))[^。;??\n]{0,20}还是[^。;??\n]{0,24}(买|选|做|用|等|去|留)/, // 「应该现在买,还是等到…」句式,允许句内逗号(TG 实测缺口 2026-07-04)
  /\bshould\s+(i|we)\b|\bwhich\s+(one|option|approach)\b|\bdecide\b|\bchoose\s+between\b|\bworth\s+(it|doing)\b/i,
];
const RE_IRREVERSIBLE = [
  /辞职|离职|裁员|解散|关(掉|停)公司/,
  /签(合同|约|字)|签.{0,8}(合同|协议)|\bterm\s*sheet\b|付(全款|定金)|全仓|清仓|梭哈|卖(房|车)|买房/i,
  /删(库|除生产|生产数据)|迁移生产|下线.{0,6}(服务|系统)/,
  /(把|将|准备|打算|决定|直接|立即|马上|今晚|明天)[^,。;\n]{0,12}(公开)?(发布|上线)|公开发布|对外宣布|发公告/,
  /不可逆|覆水难收|没有回头路/,
  /\bresign\b|\bsign\s+the\s+contract\b|\ball[- ]?in\b|\birreversible\b/i,
];
const RE_COACH_GATE = [
  /(你|妳)(替|帮)我(决定|拿主意|做决定|定)/,
  /我(实在)?(没法|无法|不会|想不了|想不清楚).{0,4}(想|判断|决定)/,
  /你说了算|听你的|随便你(定|选)|你觉得(怎么)?(好|行)就(怎么)?(来|办)/,
  /\byou\s+decide\b|\bdecide\s+for\s+me\b|\bi\s+can'?t\s+(think|decide)\b/i,
];

// —— light 触发:事实断言/引用/数字统计(§3.2)——
const RE_FACT = [
  /是什么|什么是|指的是|定义|区别是/,
  /哪(一)?年|何时|什么时候|谁(发明|提出|创立)/,
  /多少|几个|百分之|占比|增长率|市场规模|统计|数据(上|显示)/,
  /来源|引用|文献|论文|出处|根据.{0,10}(报告|研究|论文)/,
  /最新(版本)?|发布日期|现在.{0,6}(版本|价格)/,
  /\bwhat\s+is\b|\bhow\s+(many|much)\b|\bwhen\s+(was|did)\b|\bcitation\b|\baccording\s+to\b|\bstatistics\b|\blatest\s+version\b/i,
];
const RE_URL = /https?:\/\/\S+/i;

// —— 意图检测(§7.2 意图→方法族速查)——
const INTENTS = [
  ['estimate', /预测|估算|估计|大概(要)?(多少|多久)|多久能|多少钱|市场有多大|概率|可能性有多|\bforecast\b|\bestimate\b|\bhow\s+long\s+will\b|\bmarket\s+size\b/i],
  ['ideate', /点子|创意|头脑风暴|想(几个|些)(办法|方案|主意)|起(个)?名|命名|花样|\bbrainstorm\b|\bideas?\b\s*(for|about)?/i],
  ['review', /评审|审(一下|查|稿)|看看.{0,10}(对不对|有没有问题|漏洞)|挑(毛病|刺)|反驳|批判|论证.{0,6}(强|站得住)|\breview\b|\bcritique\b|\bpoke\s+holes\b/i],
  ['clarify', /帮我(想想|梳理|理清|捋)|怎么开始|从哪(儿|里)?(开始|入手)|没(有)?头绪|理不清|不知道(该)?(怎么|如何)|\bwhere\s+do\s+i\s+start\b|\bhelp\s+me\s+think\b/i],
];

function anyMatch(res, text) {
  const hits = [];
  for (const re of res) if (re.test(text)) hits.push(re.source.slice(0, 40));
  return hits;
}

/**
 * @param {string} prompt 用户输入
 * @returns {{mode:'off'|'light'|'full', stance_hint:string|null, triggers:string[], intent:string|null, menu:string[]|null}}
 */
// 站位光谱(§6,软推断塑造语气,不宣布;教练位永不在此产生——只走授权门)
const RE_MIRROR = /好累|太难受|烦死|崩溃|睡不着|委屈|想哭|绷不住|emo 了/;
const RE_MENTOR = /教教我|给我讲讲|为什么会|怎么理解|原理是什么|帮我入门|想学/;
const RE_SECRETARY = /^\s*(帮我|把|将|给我)\S{0,20}(改成|改为|写个|写一份|生成|翻译|重构|部署|跑一下|整理成)/;

function route(prompt) {
  const text = String(prompt || '');
  const triggers = [];
  let stanceHint = null;

  const coach = anyMatch(RE_COACH_GATE, text);
  if (coach.length) { triggers.push('coach_gate'); stanceHint = 'coach_gate_check'; }
  if (anyMatch(RE_DECISION, text).length) triggers.push('decision_language');
  if (anyMatch(RE_IRREVERSIBLE, text).length) triggers.push('irreversible_commitment');
  if (anyMatch(RE_FACT, text).length) triggers.push('fact_assertion');
  if (RE_URL.test(text)) triggers.push('citation_url');

  let mode = 'off';
  if (triggers.includes('fact_assertion') || triggers.includes('citation_url')) mode = 'light';
  if (triggers.includes('decision_language') || triggers.includes('irreversible_commitment') || triggers.includes('coach_gate')) mode = 'full';

  if (!stanceHint) { // 软站位:判错代价近零(§6 优先级最低组件)
    if (RE_MIRROR.test(text)) stanceHint = 'mirror';
    else if (RE_MENTOR.test(text)) stanceHint = 'mentor';
    else if (mode === 'full') stanceHint = 'strategist';
    else if (RE_SECRETARY.test(text)) stanceHint = 'secretary';
  }

  let intent = null;
  if (mode === 'full') intent = 'decide';
  for (const [name, re] of INTENTS) if (re.test(text)) { intent = name; break; }
  if (mode === 'light' && !intent) intent = 'factual';

  // P1:off 轮零打扰——不注菜单
  const menu = mode === 'off' ? null : pickMenu(intent);
  return { mode, stance_hint: stanceHint, triggers, intent, menu };
}

module.exports = { route };
