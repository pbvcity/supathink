---
name: st
description: supathink 超限思考命令入口。仅当用户明确提到 /st、/st:help 或手动命令时使用;默认不要自判升档。
---
用户显式请求 `/st`、`/st:help` 或询问 supathink 命令时,展示可用入口并保持默认关原则:

- 深审:`/st:slow <问题>`;带自出账本:`/st:slow-full <问题>`;跳过:`/st:fast <问题>`
- 会话开关:`/st:on` / `/st:off`;初始化:`/st:init`
- 合议:`/st:panel` / `/st:panel-lite` / `/st:debate` / `/st:delphi` / `/st:redblue`
- 对齐抬头:`/st:altitude`;北极星代记:`/st:win`

不要因为自己判断“值得深思”就主动外调模型或 panel。只有用户显式命令、项目/用户/agent auto 已开启,或上文已经注入建议思考方法菜单时,才按相应命令继续。
