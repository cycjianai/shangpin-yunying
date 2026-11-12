# 美团不可售任务：本地资质图整理与批量导入

本入口只属于已实现的 `platform_adapter=meituan + task_mode=unavailable_one_pass`，用于把用户已取得的资料或按
[`upstream-image-generation.md`](upstream-image-generation.md) 上游生成的证照图写入当前不可售治理 cohort。它不把独立 `qualification_images_only` 模块升级为已实现，也不能脱离当前审核原因处理
任意商品。

## 文件名与资料表

图片固定命名：

```text
SPUID_图片类型_图片标题_两位顺序号.jpg
```

例如 `22814073422_4_3C证书_01.jpg`。图片类型沿用美团 CPV：3 包装标签、4 3C、5 配料营养、6 纺织说明、
7 吊牌洗唛、8 背签、10 医疗注册/备案、11 能效、13 尺寸、14 尺码表。

先生成资料元数据模板：

```bash
python3 scripts/platforms/meituan/qualification_images/prepare_manifest.py template \
  --input-dir "$IMAGE_DIR" --output-csv "$RUN_DIR/qualification-evidence.csv"
```

运营补齐商品名、型号、资料来源、证书编号、主体、有效期、核验人、核验时间和 OCR 文本。监管资料必须来自
`official_registry`、`issuer_scan`、`regulator_scan` 或 `manufacturer_original`，并把
`verification_status` 填为 `verified`。不要把密码、Cookie、授权头或个人敏感信息写进资料表。

构建失败关闭的导入清单：

```bash
python3 scripts/platforms/meituan/qualification_images/prepare_manifest.py build \
  --input-dir "$IMAGE_DIR" --evidence-csv "$RUN_DIR/qualification-evidence.csv" \
  --wm-poi-id "$WM_POI_ID" --output "$RUN_DIR/qualification-import-manifest.json" \
  --review-csv "$RUN_DIR/qualification-import-review.csv"
```

文件身份、图片格式、尺寸、SHA-256、来源、有效期、证书编号/型号 OCR、占位词和跨 SPU 重复都会进入审核。
默认只要有一行 `blocked`，导入器整批零写入；明确使用 `--ready-only` 时只跳过并统计阻塞行。

## 导入与回读

优先由 Codex Chrome 插件在当前已登录标签页中导入 `runQualificationImport`，保持
`chrome_extension_current_tab`。只有已存在且通过身份门的 loopback managed CDP 才使用命令行：

```bash
node scripts/platforms/meituan/qualification_images/import_batch.mjs \
  --manifest "$RUN_DIR/qualification-import-manifest.json" --run-dir "$RUN_DIR" \
  --cdp-url "$CDP_URL" --canary-only
```

canary 的上传、官方完整保存、复审语义、主图保护、旧 CPV 保护和独立回读全部通过后，去掉 `--canary-only`
执行余量。导入器按 `SPU + picture_type + sequence + 文件 SHA-256` 幂等记录上传回执；新图片按顺序写在对应
CPV 类型第一位，旧图片保持原相对顺序后移。主图、详情图和其他 CPV 类型不得删除或重排。

存在旧 write intent 但没有明确终态时，先独立回读；回读不一致时标记
`unknown_previous_write_requires_review`，不得自动重发保存。最终以
`qualification-import-checkpoint.json` 和 `qualification-import-summary.json` 为准，不能用上传 URL 数量冒充写回成功。
