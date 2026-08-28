# 任务分支：资质图与专项图片

只处理用户点名的图片槽位。先读取实时槽位 ID、title、description、数量上限和当前 URL；优先同 SPU 真实图复用与
错槽迁移，确实缺少非监管制品时才进入 provider。

牵牛花执行完整读取 [策略说明](../qualification-image-policy.md)，机器唯一策略为
`scripts/qualification_image_policy.json`。美团独立 `qualification_images_only` 当前仍为 `planned`；不可售任务内的
真实资料导入不等于独立图片 writer 已实现。

法定证照、备案、注册、许可证、检验报告、公章和 3C/CCC 只接受真实可核验材料。provider 每个稳定业务键最多一次
submit；取得任务 ID 后只 query 原任务。上传成功后仍要保存、按精确槽位独立回读，并保护其他图片顺序和数量。

## 统一输出映射

- `字段ID=qualification.<slot_id>.<sequence>`，`字段名` 使用平台当前槽位显示名。
- 值使用低敏 URL 标识或内容 SHA-256，不写临时授权参数。
- 图片已生成/上传不是终态；回读且适用审核退出后为 `verified_complete`。
- 缺真实材料为 `manual_evidence_required`，结果表不得用空白或“失败”吞掉原因。
