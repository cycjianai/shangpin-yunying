# 任务分支：美团医疗器械整店迁移

仅适用于美团买药/医疗器械商家版，状态为 `runtime_guided`。完整读取
[整店迁移合同](../meituan-medical-device-store-migration.md)。不得使用美团超市/闪购的 payload、标品假设或保存端点。

## 固定阶段

1. 源店全量归档：分页列表与完整详情集合对账；SKU、属性、完整分类路径和媒体角色/顺序全部归档。
2. 媒体离线化：按 URL 与内容 SHA-256 去重，记录角色、顺序、字节数和失败原因。
3. 目标店分类复制：先一级再二级，回读完整路径和父子关系。
4. 目标预检与样本：1 条完整闭环后，再用 5 条覆盖多 SKU、资质图、详情图和标库查询。
5. 建品路由：目标已存在、标库唯一、标库零匹配、多匹配、可自建、审核中和待优化必须分流。
6. 创建后全字段覆盖：以目标最新对象为基底，只覆盖可迁移字段；目标 ID、审核流水和活动 ID 不硬拷贝。
7. 独立回读：按 identity、main、store_category、attributes、sales、store_code、main/detail/qualification_media 字段组验真。

## 统一输出映射

- 源 SPU 为 `SPUID`；目标身份用 `migration.target_spu_id` 和 `migration.target_sku_id`。
- 分类、属性、销售、店内码和每个媒体角色分别使用统一字段命名空间，不把“创建成功”合并为一行。
- 所有必需字段组通过为 `verified_complete`；单个源媒体无效可为 `blocked` 或经合同允许的部分状态，但不能写完全一致。
- 标库不存在、审核中、待优化、单规格限制和类目冲突逐条保留。
