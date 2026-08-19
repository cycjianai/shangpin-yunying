# 平台 × 任务模块总表

平台和任务类型是两个正交维度。平台适配器负责登录会话、原生接口、payload、保存和回读；共享核心负责 manifest、
任务合同、审计、统一运营 Excel Schema、完成门和交付门。所有已实现模块必须把不同 checkpoint 映射为同一
`product-governance-operations-workbook-v1`，不得定义平台专属运营表。

| `platform_adapter` | 属性信息 `channel_attributes_only` | 资质图 `qualification_images_only` | 不可售治理 `unavailable_one_pass` | 平台文件 |
|---|---|---|---|---|
| `qnh` | `implemented` | `implemented` | `implemented` | `platform-qnh.md` |
| `meituan` | `planned` | `planned` | `implemented` | `platform-meituan.md` |
| `aoxiang` | `implemented` | `planned` | `planned` | `platform-aoxiang.md` |
| `taobao_flash` | `planned` | `planned` | `planned` | `platform-taobao-flash.md` |

`planned` 固定表示没有生产 writer：只允许做平台识别、只读能力盘点和适配器开发，不允许处理真实商品写入。
美团 `unavailable_one_pass` 内部可以调用其已注册的本地资质图整理/导入动作；这不等于独立
`qualification_images_only` writer 已实现。

目标代码布局：

```text
scripts/
  core/                         # manifest、合同、审计、Excel、完成/交付门
  platforms/
    qnh/{attributes,qualification_images,unavailable_one_pass}/
    meituan/{attributes,qualification_images,unavailable_one_pass}/
    aoxiang/{attributes,qualification_images,unavailable_one_pass}/
    taobao_flash/{attributes,qualification_images,unavailable_one_pass}/
```

现有 canonical 脚本先保持路径稳定；迁移时使用兼容入口逐模块搬迁，每次只迁一个平台的一类任务，并先更新合同哈希与
回归测试。新平台专属代码必须直接进入目标模块，不再增加新的顶层混合 writer。

每个已实现模块必须独立注册：平台识别规则、允许的任务模式、只读器、计划器、writer、独立回读器、validator、
checkpoint schema、统一运营行映射、完成门扩展和平台回归。模块之间禁止直接复用 writer；只能调用 `core` 的中立接口。
