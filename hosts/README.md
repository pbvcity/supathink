# hosts/ —— 宿主适配层

supathink 的核心(src/lib、src/daemon)宿主无关;每个宿主只有一层接线,按宿主组织:

| 宿主 | 接线机制 | 本目录内容 | 安装方式 |
|---|---|---|---|
| Claude Code | 用户级 HTTP hooks + /st:* 命令 + CLAUDE.md 协议块 | (无独立文件,接线逻辑在 install.sh) | `./install.sh` 自动检测 |
| Codex | 用户级 hooks.json(curl shim)+ prompts + AGENTS.md 协议块 | (同上) | `./install.sh` 自动检测;首次需在 codex 里 `/hooks` 授信 |
| OpenClaw | 原生插件(id=supathink):before_agent_finalize 硬拦截 + message_sending 脚注 | [openclaw/](openclaw/) 插件包 | `./install.sh` 自动检测(--link 安装+置位 allowConversationAccess),装后重启网关一次 |

约定:插件 id 一律 `supathink`;目录名 = 宿主名;新宿主加一个子目录 + install.sh 一个探测分支。
