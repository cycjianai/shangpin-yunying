# 平台 × 任务能力总表

机器唯一能力表为 [`scripts/capability_registry.json`](../scripts/capability_registry.json)。本文件只供人工快速审阅；
路由时执行 `scripts/route_skill.py`，不要为了选分支读取所有平台合同。

平台和任务是两个正交维度。平台适配器拥有登录身份、请求、签名、reader、planner、writer、回读器和平台事实判断；
共享核心只拥有 manifest、统一业务终态、审计事件、资源门、Excel Schema 和完成/交付门。平台模块禁止直接复用请求、签名、
writer、Cookie、回读器或成功捷径。

状态含义：

- `implemented`：当前包内有已注册实现；仍须当前身份、canary、独立回读和完成门。
- `runtime_guided`：有稳定业务合同和历史定位线索，但端点/载荷必须从当前页面证据发现；没有当前证据时零写入。
- `planned`：没有生产 writer；只允许识别平台、只读盘点和开发适配器。

## 商品治理能力

| `platform_adapter` | `channel_attributes_only` | `unavailable_one_pass` | `qualification_images_only` | `plugin_attribute_fill` | `copy_history_retry` |
|---|---|---|---|---|---|
| `qnh` | `implemented` | `implemented` | `implemented` | `implemented` | `implemented` |
| `meituan` | `planned` | `implemented` | `planned` | `planned` | `planned` |
| `eleme` | `planned` | `planned` | `planned` | `planned` | `planned` |
| `aoxiang` | `implemented` | `planned` | `planned` | `planned` | `planned` |
| `taobao_flash` | `planned` | `planned` | `planned` | `planned` | `planned` |

美团 `unavailable_one_pass` 可以调用其模块内已注册的真实资质资料导入，但不等于独立
`qualification_images_only` 已实现。

## 商品运营能力

| `platform_adapter` | `price_push` | `product_editing` | `medical_device_store_migration` | `protected_request_maintenance` |
|---|---|---|---|---|
| `qnh` | `planned` | `planned` | `planned` | `runtime_guided` |
| `meituan` | `runtime_guided` | `runtime_guided` | `runtime_guided` | `planned` |
| `eleme` | `runtime_guided` | `planned` | `planned` | `planned` |
| `aoxiang` | `planned` | `planned` | `planned` | `planned` |
| `taobao_flash` | `planned` | `planned` | `planned` | `planned` |

牵牛花另有 `headquarters_price_fill=runtime_guided`：按授权货盘补齐空总部零售价，优先当前官方 Excel 导入；
它独立于 `price_push`，不能推断门店、活动价或其他平台调价已实现。详见 `tasks/qnh-headquarters-price-fill.md`。

## 目录职责

```text
references/platforms/   # 轻量平台入口与可复用会话/身份流；每次只读一个
references/tasks/       # 轻量功能分支；每次只读一个
references/*.md         # 详细叶子合同；只按路由器 load_order 读取
scripts/platforms/      # 已实现的平台专属代码
scripts/core/           # 统一事件、工作簿和验证
```

新增能力时先注册平台识别、任务状态、reader、planner、writer、readback、validator、checkpoint、统一事件映射和回归，
再修改机器能力表。文档合同、另一个平台已实现或页面按钮存在都不能把 `planned` 升级为 `implemented`。
