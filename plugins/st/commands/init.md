---
description: supathink 超限思考:首次安装引导 / 配置向导(AI 带你把 daemon、密钥、宿主接线一步步装好)
---
用户在通过 supathink 插件壳请求安装或配置超限思考系统。本插件只提供命令入口;真正的 daemon 与宿主接线由 install.sh 完成。请**带着用户一步步做**,每步说明在做什么、征得同意后再执行(这是在用户机器上跑安装脚本,透明与确认是底线):

1. 先检测是否已安装:`test -f ~/.supathink/bin/supathink && ~/.supathink/bin/supathink status`。已装则跳到第 4 步做配置。
2. 取得源码(询问用户偏好):
   - 若本机已 clone 过 supathink 仓库,用其目录;否则 `git clone https://github.com/pbvcity/supathink.git /tmp/supathink-src`(或用户指定目录)。
3. 运行安装:`cd <源码目录> && SUPATHINK_SKIP_CC_COMMANDS=1 ./install.sh`(壳插件已提供命令,故跳过重复写入)。它会自动检测本机的 Claude Code / Codex / OpenClaw 并分别接线,daemon 落到 ~/.supathink。向用户复述它打印的"一次性动作"(Codex 需 /hooks 授信;OpenClaw 需重启网关)。
4. 配置密钥(用 AskUserQuestion 或对话确认要配哪些;**不要让用户把 key 贴进对话**,给命令让其自己在终端执行):
   - DeepSeek(强烈推荐,校验主力):`read -rs -p "DeepSeek API Key: " K && printf "\nSUPATHINK_DEEPSEEK_API_KEY=%s\n" "$K" >> ~/.supathink/env && unset K`
   - 可选:GLM(合议中文席)、MiniMax(Judge)、Tavily(事实检索)——端点模板见 ~/.supathink/env,同法追加对应 SUPATHINK_*_API_KEY。
5. 选激活范围(AskUserQuestion):默认全关(仅显式命令触发)/ 某项目自动分档(该项目根写 `.supathink.json` `{"auto":true}`)/ 全局自动(`~/.supathink/env` 设 `SUPATHINK_AUTO=true`)。解释默认关是推荐——日常零打扰。
6. 收尾:`~/.supathink/bin/supathink status` 展示生效配置,并告诉用户:`/st:slow <决策问题>` 触发一次深审试试,`supathink log` 看过程,`/st:win` 标记真实救场。

$ARGUMENTS
