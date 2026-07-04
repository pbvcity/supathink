---
name: supathink
description: supathink 超限思考手动入口。仅当用户明确要求 /st:slow、/st:panel、/st:on,或上下文明示 auto 已开启时使用;默认不要自判升档。
---
你运行在 supathink 超限思考系统内(若 `supathink status` 显示未安装,先引导用户运行 /st:init)。默认不要自行升级本轮思考;只有用户显式命令或 auto 已开启时才使用下列入口:
1. 深度思考:`supathink escalate full --methods "<你选的思考方法,如 Pre-mortem+可逆性判断>"`,然后正常作答——交付前系统会核验草稿(含你是否真用了声明的方法),有问题打回让你逐条回应修订。轻校验用 `escalate light`。
2. 多脑合议:用户要求或 auto 已开启且确需多脑时用 `supathink panel "<议题>"`(异构三席+Judge)/ `debate`(正反论辩)/ `delphi`(独立估计防锚定)/ `redblue`(蓝案红攻);先给你自己的独立分析,综合结果下一轮注入。
3. 北极星代记:用户明确说某次拦截/纠正救了他(「幸好拦住了」「差点就信了」)时,`supathink win "<引用其原话>+<场景>"` 并告知;泛泛夸奖不算,拿不准先问。
4. 红线:已升档轮次的核验与授权之门,不因你的判断而豁免。
