# 美团不可售任务：本地资质图整理与批量导入

本入口只属于已实现的 `platform_adapter=meituan + task_mode=unavailable_one_pass`，用于把用户已经取得的真实资料
写入当前不可售治理 cohort。它不把独立 `qualification_images_only` 模块升级为已实现，也不能脱离当前审核原因处理
任意商品。

## 运营自助 Python 工具

不需要 Codex 介入时，直接运行：

```bash
python3 scripts/platforms/meituan/qualification_images/meituan_qualification_tool.py
```

默认打开中文菜单，任务数据和回执写入 `~/Documents/美团资质图导入/`：

1. `启动专用浏览器`：以只监听 `127.0.0.1:9333` 的独立 Chrome 用户目录启动，不读取或关闭日常 Chrome；运营自行登录。
2. `扫描哪些商品需要资质图`：只读冻结美团“审核失败”列表，生成 `待补资质清单.csv`，逐行列出 SPU、商品名、图片类型、资料名称和平台说明。
3. `按图片目录生成资料核验表`：按下述文件名规则生成 `qualification-evidence.csv`，由资料核验人补齐真实来源。
4. `校验资料并生成导入清单`：输出 `qualification-import-review.csv`；存在阻塞项时整批零写入。
5. `导入 1 个商品测试`：上传、官方保存并独立回读一个 SPU。只有同一 manifest 的 canary 状态为 `readback_verified` 才开放全量。
6. `批量导入 / 断点续跑`：实时显示 SPU 和图片进度；已回读成功的 SPU 自动跳过。
7. `查看进度和状态回执`：生成 `qualification-status.csv`。`图片上传完成` 不是成功，只有“保存并回读验证成功”才算成功。

命令行模式也可单独调用：

```bash
TOOL=scripts/platforms/meituan/qualification_images/meituan_qualification_tool.py
python3 "$TOOL" browser-start
python3 "$TOOL" scan
python3 "$TOOL" template --input-dir "/path/to/images"
python3 "$TOOL" build
python3 "$TOOL" canary
python3 "$TOOL" import
python3 "$TOOL" status
```

如需改变任务目录或端口，把全局参数放在子命令前，例如
`python3 "$TOOL" --run-dir "/path/to/run" --cdp-url http://127.0.0.1:9444 scan`。
工具保留 `operator-events.jsonl`、逐图上传回执、write intent、checkpoint、summary、失败原因和逐 SPU CSV，支持审计与续跑。

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
