# supathink for OpenClaw

让 OpenClaw agent 真正思考。回答交付前经 `before_agent_finalize` 送 supathink daemon 审稿:**Critic** 查正确性(引用取回比对/事实检索核验/逻辑),**Navigator** 查方向;有问题打回让 agent 重想。思考方法运用与多模型合议(panel/debate/delphi/redblue)由 daemon 统一编排。

## 前置

需先在本机(或本容器)安装 supathink daemon:
```
git clone https://github.com/pbvcity/supathink.git && cd supathink && ./install.sh
```
`install.sh` 检测到 OpenClaw 会自动 link 本插件并置位 `allowConversationAccess`。ClawHub 安装则只装插件壳,daemon 仍需上面这步。

## 配置

agent 粒度开关在 `~/.supathink/openclaw.json`(默认全关);`auto:true` 的 agent 自动分档。详见 https://github.com/pbvcity/supathink
