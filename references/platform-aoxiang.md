# 翱象模块

- `platform_adapter=aoxiang`
- 唯一平台一级入口：[references/platforms/aoxiang.md](platforms/aoxiang.md)
- 渠道属性与不符合渠道规则治理：`implemented`，完整合同见 [aoxiang-channel-contract-v1.md](aoxiang-channel-contract-v1.md) 与 [aoxiang-playbook-and-pitfalls.md](platforms/aoxiang-playbook-and-pitfalls.md)。
- 商品高速批量改名与编辑：`implemented`，引擎见 `scripts/aoxiang_high_concurrency_product_engine.mjs`。
- 资质图挂载与提审：`implemented`，规范见 [aoxiang-playbook-and-pitfalls.md](platforms/aoxiang-playbook-and-pitfalls.md)。

所有翱象主档修改（`POST /goods/master/update`）必须严格执行**多规格防覆盖四道代码级硬门禁**（全门店写前快照 ➔ 100% 无条件调用 `relation/detail` 且失败即抛错熔断 ➔ 发送前 `assertMultiSpecSafe` 数量硬断言 ➔ 首单多规格 Canary 独立回读验真）。
