# supathink 超限思考

**[中文](#中文说明) | [English](#english)**

---

## 中文说明

**让 AI 真正地思考,而不是张口就答。**

单遍生成的 AI 有三个天花板:想不深(不用方法,直觉输出)、想不广(一个大脑一个视角)、可能想错(幻觉与跑偏恰在你最信任时发生)。supathink 装在 Claude Code / Codex / OpenClaw 之上,把值得深思的问题升级为一次完整的思考过程:

- **想得深(思考方法)**:AI 按问题类型运用结构化思考法——决策矩阵、Pre-mortem、钢人论证、费米估算……9 族 69 法按意图注入,模型自选并声明「本轮采用 X」,**声明即契约**,会被核验是否真用了。
- **想得广(多脑合议)**:重大命题一个大脑不够——召集多个异构 AI 分角色思考:三席专家团+裁判(panel)、正反论辩(debate)、独立估计防锚定(delphi)、蓝方案红攻击(redblue)。
- **想得对(双轴校验)**:思考产出交付前过两道审——**Critic** 查正确性(引用取回比对/事实检索核验/逻辑与自相矛盾,工具落地不凭记忆),**Navigator** 查方向(你要的是流量,还是能转化的流量?)。有问题打回,逐条回应批注后修订交付。
- **越用越懂你(Playbook)**:你认可的思考配方被存档复用,逐渐长成你自己的决策风格库。

何时深思由谁定?主要是 **AI 自己**(理解语境后自判升档、自选方法、自主召集合议)+ 你的命令 + 规则兜底。

**唯一成功标准**:某一天,它让 AI 想出了你自己想不到的答案,或拦下了一个你差点采纳的错误结论。

**核心承诺**:校验是升级,不是税。日常 coding/闲聊零打扰(off 档实测 +3ms);默认全关;任何组件故障静默退化为原生宿主,绝不阻塞你。

---

### 功能一览

| 能力 | 说明 |
|---|---|
| 思考方法系统 | 值得深思的轮次按意图注入方法菜单(9 族 69 法),模型自选并声明——**声明即契约**,full 档核验是否真用了 |
| 多模型合议 | `/st:panel`(三席+Judge)· `/st:debate`(正反论辩)· `/st:delphi`(独立估计→匿名汇总→修正)· `/st:redblue`(蓝案红攻)· `/st:panel-lite`(1× 成本);Judge 强制异于所有席位 |
| 谁决定深思 | **模型自判**(主通道,AI 理解语境自己升档/选法/召集合议)· 你的命令(`/st:slow`)· 规则兜底网 · 项目/会话/agent 配置 |
| 三档校验 | off(零介入)/ light(交付前 ≤2s 快查拦 blocker + 交付后异步深查、下轮 ⚠ 提醒)/ full(Critic∥Navigator 并审,打回修订 ≤2 轮 + 核验脚注) |
| Playbook | 强认可时存档思考配方,同类命题自动复用;周复验涨衰退役;永不能预授权教练站位 |
| 可观测 | `supathink log`(逐轮全记录)· `supathink stats`(四指标)· healthz 引擎面板;全部 trace 本地留档 |

---

### 依赖与成本(装之前请读完这一节)

#### 你需要什么

| 依赖 | 必需? | 用途 |
|---|---|---|
| Node.js ≥ 20 | 必需 | daemon 与全部脚本的运行时 |
| bash / curl / git | 必需 | 安装与 hook 接线 |
| 三宿主之一 | 必需 | Claude Code / Codex CLI / OpenClaw,至少装一个 |
| DeepSeek API key | **强烈推荐** | 快审/慢查/全审主力(单次 2–6s);**不配也能跑**:回退宿主自带模型(CC→haiku,Codex→gpt-5.4-mini,走你的订阅,较慢 30–90s) |
| GLM Coding Plan(z.ai/bigmodel) | 可选 | 仅多模型合议的席位(panel 中文席/debate 反方/红蓝红方);不配则相应合议自动降级或拒绝并说明缺席 |
| MiniMax Token Plan | 可选 | 仅 Judge(panel/debate 裁决、full 分歧兜底)与 delphi 席位;不配则 panel/debate 拒绝启动(无 Judge 不综合),full 分歧改为如实标注未决 |
| Tavily API key(免费档即可) | 可选 | fact 类断言的检索核验;不配则此类断言标 skipped 不裁决(引用 URL 的取回比对不依赖它,始终可用) |

#### 每个动作花什么钱(实测量级)

| 你做什么 | 外部调用 | 量级(实测) |
|---|---|---|
| 日常 coding / 闲聊(off 档) | **零调用** | 0 |
| light 轮(事实/引用类问题) | DeepSeek ×1(快查,关推理)+ 异步 ×2(提取+裁决)+ Tavily ≤2 次 + 被引 URL 的直接抓取(免费) | 合计约 3k–8k tokens |
| full 轮(决策类) | DeepSeek 全审 ×(1+修订次数,≤3)+ Navigator ×1;撞分歧上限时 MiniMax Judge ×1 | 每次全审 2k–10k tokens |
| `/st:panel` | DeepSeek ×2 席 + GLM ×1 席 + MiniMax Judge ×1 | 4 次强档调用,~1 分钟 |
| `/st:debate` | 正反两轮 ×4 + Judge ×1 | 5 次,实测 ~50s |
| `/st:delphi` | 3 席 ×2 轮 + 汇总 ×1 | 6–7 次,实测 ~1 分钟 |
| `/st:redblue` | 蓝红交替 ×4 | 4 次,实测 ~2 分钟 |
| daemon 启动 | 各引擎探活各 1 次极小调用 | 忽略不计 |
| playbook 复验 / stats / log | 纯本地 | 0 |

**成本性质**:DeepSeek 按 token 计费(单价见其官方定价页;供参考:本项目两天开发期全部测试共消耗几十次调用,量级在"几毛到几块钱人民币");GLM/MiniMax 走你的**订阅池**(与你其他用途共享额度,注意订阅 key 与按量 key 不可混用);宿主回退模式消耗**宿主订阅 quota**(零边际支出但占用额度)。合议类命令是大头——所以它们**永不自动触发**,只响应你或模型的显式召集。

#### 数据去哪了(隐私)

- 升档轮的**用户问题与模型草稿**会被发送到你配置的校验后端(DeepSeek;合议时还有 GLM/MiniMax)——如果你的对话涉密,请只用宿主回退模式(数据不出你已信任的宿主厂商)或对敏感会话保持 off/`/st:fast`;
- fact 核验会把**断言文本**作为检索词发给 Tavily;draft 中出现的 **URL 会被 daemon 直接抓取**(向目标网站暴露你的服务器 IP);
- trace/quota/playbook 全部**只存本地** `~/.supathink/`;daemon 只绑 127.0.0.1;API key 明文存于 `~/.supathink/env`(权限归你,永不进 git)。

---

### 安装

**方式一 · 插件市场(Claude Code / Codex)**——先装壳再由 AI 引导:
```
/plugin marketplace add pbvcity/supathink
/plugin install st@supathink
/st:init          # AI 带你装 daemon、配 key、设激活范围
```

**方式二 · 直接安装(全宿主通用,含 OpenClaw)**:
```bash
git clone https://github.com/pbvcity/supathink.git && cd supathink
./install.sh    # 自动检测本机的 CC/Codex/OpenClaw 并分别接线;默认全关
```

#### 命令入口口径(三宿主差异)

| 宿主/安装方式 | 聊天命令形态 | 说明 |
|---|---|---|
| Claude Code / Codex 插件(`st@supathink`) | `/st:slow` `/st:panel` `/st:on` | 插件 id 为 `st`,命令命名空间统一走 `/st:`;下方命令表默认使用这一形态 |
| Codex 直接安装(`./install.sh`,未装插件) | `/st-slow` `/st-panel` `/st-on` | Codex flat prompts 不支持冒号命名空间,所以直装 fallback 写入 `~/.codex/prompts/st-*.md`;已装插件时 prompts 应为空 |
| OpenClaw / Telegram 菜单 | `/stslow` `/stpanel` `/ston` | Telegram 命令名不允许冒号或连字符,菜单用无分隔符 `st*`;daemon 仍兼容文本里手打 `/st:slow` 等前缀 |

一次性动作(按你有的宿主):

| 宿主 | 动作 |
|---|---|
| Claude Code | 无(hooks/命令/skill/协议块已就位) |
| Codex | 在 codex 交互界面执行 `/hooks`,批准 supathink 条目(授信机制,不批不运行) |
| OpenClaw | 重启一次网关加载插件;在 `~/.supathink/openclaw.json` 把想启用的 agent 设 `"auto": true`(默认全关) |

配 key(推荐,不进 shell 历史):

```bash
read -rs -p "DeepSeek API Key: " K && printf "\nSUPATHINK_DEEPSEEK_API_KEY=%s\n" "$K" >> ~/.supathink/env && unset K
```

其余 key(GLM/MiniMax/Tavily)同法写入 `~/.supathink/env`,模板与端点注释见 [env.example](env.example)。改 env 即时生效。

**验证安装**:`supathink status`(daemon/开关/配置)→ 对话里发 `/st:slow 该不该把服务迁到自建机房?` → 回答应带「── 核验 ──」脚注 → `supathink log` 看这一轮的完整校验记录。

### 使用

#### 开关优先级(高 → 低)

本轮命令(`/st:slow` 必审 / `/st:fast` 必跳)→ 会话开关(`/st:on` `/st:off`)→ agent 级(OpenClaw)/ 项目级(`.supathink.json`)→ 用户级(env `SUPATHINK_AUTO`)→ **默认全关**。总开关:`supathink on|off`(或 touch/rm `~/.supathink/DISABLED`)。

#### 命令全表

| 命令 | 作用 |
|---|---|
| `/st:slow` / `/st:slow-full` | 本轮 full 深审 / 深审且模型先自出 claim 账本 |
| `/st:fast` | 本轮跳过一切校验 |
| `/st:on` / `/st:off` | 本会话开/关自动分档 |
| `/st:panel` / `/st:panel-lite` | 异构三席+Judge / 单模型三视角(1×) |
| `/st:debate` / `/st:delphi` / `/st:redblue` | 正反论辩+裁决 / 独立估计→匿名汇总→修正 / 蓝案红攻 |
| `/st:altitude` | Navigator 手动抬头(目标/代理指标七轴) |
| `/st:win 描述` | 北极星:记录一次真实救场(三宿主聊天内可用;AI 在你明确正反馈时也会代记) |
| `/st:init` | AI 引导写配置 |
| CLI:`supathink status/log/stats/quota/win/on/off/escalate/panel…` | 状态/逐轮记录/四指标/成本/**标记一次真实救场(北极星)**/开关/自判升档/召集合议 |

#### 什么时候会发生什么

- **思考方法菜单**:本轮升到 light/full 时按意图注入 5–8 法(决策→矩阵/Pre-mortem/可逆性;估算→费米/基率;审稿→钢人/证伪…),模型自选并声明「本轮采用 X」——**声明即契约**,full 档核验是否真用了(违约=major 打回);off 轮永不注入。
- **多模型合议**:**永不自动触发**(N× 成本)——只响应你的 `/st:panel|debate|delphi|redblue` 命令、模型自判召集(`supathink panel "议题"`)、或终端 CLI;结果后台跑完于**下一轮**注入。唯一半自动:full 修订循环撞上限仍有分歧时,Judge 自动仲裁一次或如实标注未决。
- **谁决定升档**:模型自判是主通道(它理解语境后执行 `supathink escalate`),关键词规则只是兜底网;已升档轮次的核验与授权红线不因任何判断豁免。
- **站位软提示**:升档轮按语境提示模型站位(倾诉→镜子/求教→导师/决策→军师/执行→秘书),判错无害;教练站位只能走实时授权门,任何配置都预授权不了。

#### OpenClaw 分 agent 开关

一套实例装一次,agent 粒度由 `~/.supathink/openclaw.json` 控制(容器部署时该文件在 home 卷内,宿主侧可直接编辑):

```json
{ "default": "off", "agents": { "agent-a": { "auto": true }, "agent-b": { "auto": false } } }
```

`auto:true` = 该 agent 自动分档;`auto:false` = 仅手动命令(插件形态 `/st:slow` `/st:on`,OpenClaw/TG 菜单形态 `/stslow` `/ston`)或高危话题自查可唤起;改完即生效无需重启;策略关的 agent 每轮仅一次本地回环(1–2ms)零成本。

#### 卸载

`./uninstall.sh` —— hooks/协议块/命令/插件全摘,`~/.supathink` 数据保留。

### 平台与状态

- **Linux 实测 ✓**(本项目的全部 DoD 与实测都在 Linux 完成);macOS 理论可用未实测(已修 flock/sed 兼容);Windows 请走 WSL


---

## English

**Make your AI actually think — not just answer.**

Single-pass AI has three ceilings: it doesn't think deeply (no method, gut output), doesn't think widely (one brain, one view), and sometimes thinks wrong (hallucination and goal-drift strike exactly when you trust it most). supathink sits on Claude Code / Codex / OpenClaw and turns questions worth thinking about into a full thinking process:

- **Think deeper (methods)** — the AI applies structured thinking techniques matched to your question: decision matrix, pre-mortem, steelman, Fermi estimation… 69 methods in 9 families. It picks, declares "using X this turn", and **the declaration is a contract** — verified afterwards.
- **Think wider (deliberation)** — big questions deserve more than one brain: a heterogeneous expert panel + judge, pro/con debate, anchor-free delphi estimation, blue-plan/red-attack.
- **Think right (dual review)** — before delivery, **Critic** checks correctness (citations fetched & compared, facts search-verified, logic & self-contradiction — tools, never memory) and **Navigator** checks direction ("do you want traffic, or traffic that converts?"). Problems send the draft back for revision.
- **Learns your style (playbooks)** — thinking recipes you endorse get saved and reused; over time it becomes your personal decision playbook.

Who decides when to think hard? Mostly **the AI itself** (it reads context, escalates, picks methods, convenes deliberation), plus your commands, plus a rule-based safety net.

**The single success metric**: the day it thinks of an answer you wouldn't have, or intercepts a wrong conclusion you were about to act on.

**The promise**: verification is an upgrade, not a tax. Zero interference on everyday coding and chat (measured +3ms on skipped turns); everything is **off by default**; any component failure silently degrades to your native assistant.

### Features

| Capability | Description |
|---|---|
| Three tiers | off (zero touch) / light (≤2s pre-delivery blocker check + async deep verification, findings surfaced next turn) / full (Critic ∥ Navigator, revise loop ≤2, verified footer) |
| Who escalates | **The model itself** (main channel — it judges context and runs `supathink escalate`), your commands (`/st:slow`), a rule-based safety net, and per-project/session/agent config |
| Thinking methods | On escalated turns a 5–8 item method menu is injected by intent (decision matrix, pre-mortem, steelman, Fermi…). The model picks and declares — **declaration is a contract**, verified on full tier |
| Multi-model deliberation | `/st:panel` (3 heterogeneous seats + Judge) · `/st:debate` · `/st:delphi` · `/st:redblue` · `/st:panel-lite` (1x cost). The Judge must differ from every seat — enforced |
| Playbooks | On strong approval, save the thinking recipe; auto-reuse on similar questions; weekly review (confidence up on approval, decay when idle or beaten by baseline). Can never pre-authorize the coach stance |
| North Star | `/st:win <what it saved you from>` in any chat marks a real save — the only metric that counts |
| Observability | `supathink log` (per-turn trace) · `supathink stats` (4 metrics) · engine health panel; all traces stay local |

### Dependencies & cost

| Dependency | Required? | Used for |
|---|---|---|
| Node.js >= 20, bash/curl/git | Yes | runtime & install |
| One of the three hosts | Yes | Claude Code / Codex CLI / OpenClaw |
| DeepSeek API key | Strongly recommended | main verification backend (2-6s per call). **Works without it**: falls back to your host's own model (CC to haiku, Codex to gpt-5.4-mini; slower, uses your subscription) |
| GLM coding plan | Optional | deliberation seats only; absent seats are reported, never faked |
| MiniMax token plan | Optional | Judge + delphi seat; without it panel/debate refuse to run (no Judge, no synthesis) |
| Tavily key (free tier) | Optional | search-verification of factual claims; URL-citation checking works without it |

Cost per action (measured): off turns = **zero external calls**; light = 3k-8k tokens; full = 2k-10k tokens per review x (1 + revisions, max 2); panel = 4 strong-model calls (~1 min); debate = 5 (~50s); delphi = 6-7; redblue = 4 (~2 min). Deliberation is the expensive part — which is why it **never auto-triggers**.

**Where your data goes**: on escalated turns your question and the draft answer are sent to the verification backends you configured (DeepSeek; plus GLM/MiniMax during deliberation). Factual claims go to Tavily as search queries; URLs quoted in drafts are fetched directly by the daemon. Traces, quotas and playbooks stay local in `~/.supathink/`; the daemon binds 127.0.0.1 only; keys live in `~/.supathink/env` and never enter git. For sensitive sessions stay on host-fallback mode or `/st:fast`.

### Install

**Option A · Plugin marketplace (Claude Code / Codex)** — install the shell, then let the AI guide you:
```
/plugin marketplace add pbvcity/supathink
/plugin install st@supathink
/st:init          # the AI walks you through daemon install, keys, activation scope
```

**Option B · Direct (all hosts incl. OpenClaw)**:
```bash
git clone https://github.com/pbvcity/supathink.git && cd supathink
./install.sh    # detects your hosts and wires each; everything off by default
read -rs -p "DeepSeek API Key: " K && printf "\nSUPATHINK_DEEPSEEK_API_KEY=%s\n" "$K" >> ~/.supathink/env && unset K
```

#### Command prefixes by host

| Host / install path | Chat command shape | Notes |
|---|---|---|
| Claude Code / Codex plugin (`st@supathink`) | `/st:slow` `/st:panel` `/st:on` | The plugin id is `st`, so plugin commands use the `/st:` namespace; the command table below uses this form |
| Codex direct install (`./install.sh`, no plugin) | `/st-slow` `/st-panel` `/st-on` | Codex flat prompts cannot use the colon namespace, so direct install falls back to `~/.codex/prompts/st-*.md`; with the plugin installed, prompts should stay empty |
| OpenClaw / Telegram menu | `/stslow` `/stpanel` `/ston` | Telegram command names disallow colons and hyphens, so menu buttons use separator-free `st*`; the daemon still accepts typed `/st:slow`-style prefixes |

One-time steps: **Codex** — run `/hooks` inside codex and approve the supathink entries. **OpenClaw** — restart the gateway once, then enable agents in `~/.supathink/openclaw.json`.

Verify: `supathink status` → ask `/st:slow should we migrate off the cloud?` → the answer should carry a verification footer → `supathink log`.

### Usage

Switch priority (high to low): per-turn commands (`/st:slow` / `/st:fast`) → session (`/st:on` / `/st:off`) → per-agent (OpenClaw) / per-project (`.supathink.json`) → user env (`SUPATHINK_AUTO`) → **off by default**. Kill switch: `supathink on|off`.

| Command | Effect |
|---|---|
| `/st:slow` · `/st:slow-full` | full review this turn · same, plus the model writes its claim ledger first |
| `/st:fast` | skip everything this turn |
| `/st:on` · `/st:off` | session auto-tiering on/off |
| `/st:panel` · `/st:panel-lite` · `/st:debate` · `/st:delphi` · `/st:redblue` | deliberation workflows (run in background, synthesis injected next turn) |
| `/st:altitude` | manual Navigator sweep (goals / proxy metrics) |
| `/st:win <desc>` | mark a real save (North Star; the AI also records it when you clearly say an interception saved you) |
| `/st:init` | AI-guided configuration |

OpenClaw per-agent control — one install per instance, agents governed by `~/.supathink/openclaw.json`:

```json
{ "default": "off", "agents": { "agent-a": { "auto": true }, "agent-b": { "auto": false } } }
```

`auto:false` agents can still be invoked manually (plugin form `/st:slow` `/st:on`, OpenClaw/TG menu form `/stslow` `/ston`) or by their own high-stakes self-check; edits apply instantly, no restart needed. Uninstall: `./uninstall.sh` (removes hooks/protocol/commands/plugin; keeps your data).

### Platform & license

Linux — fully tested. macOS — should work, untested. Windows — use WSL. License: Apache-2.0.
