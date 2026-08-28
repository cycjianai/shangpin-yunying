# 运行手册

## 建议目录与端口

每次任务必须创建独立 run-dir；profile 仅在没有可复用空闲会话时新建：

```bash
RUN_DIR="/home/ubuntu/e2e-browser-lab/runs/qnh-$(date +%Y%m%d-%H%M%S)"
PROFILE_DIR="/home/ubuntu/e2e-browser-lab/profiles/qnh-$(date +%Y%m%d-%H%M%S)" # 仅新建浏览器时
mkdir -p "$RUN_DIR"
```

端口只监听 `127.0.0.1`。示例：

- CDP：9292
- noVNC：6092
- VNC：5992

启动新浏览器前先发现既有 Skill 会话。只有会话健康且只读审计确认没有运行中/待续传任务时才复用其原端口；复用后为本任务新建 run-dir 并重新 `preflight`。端口被占用但会话忙碌、来源未知或证据不完整时，选新的独立端口，绝不抢占或关闭旧浏览器。

用户本机隧道示例：

```bash
ssh -fN -o ExitOnForwardFailure=yes \
  -L 6092:127.0.0.1:6092 \
  -L 9292:127.0.0.1:9292 \
  YOUR_SSH_HOST
```

然后访问 `http://127.0.0.1:6092/vnc.html`。CDP 不应暴露到公网。

优先使用 `scripts/start_qnh_browser.sh` 启动；如果默认端口或 X display 已占用，
先只读检查 `ss -ltn` 与 `/tmp/.X*-lock`，再为本次会话选择新的独立值。

## 清单与文件约定

一次运行至少保留：

- `session_identity.json`：用户指定与实际 CDP/profile、tenant/store、店铺名、route、筛选 URL 和 run-dir；
  任一身份不符时本次读数无效且上传/保存零发送。
- `source-manifest.*.readonly` 与 `source-manifest.sha256`：用户原始清单的只读备份、范围和哈希（若有）。
- `manifest-*.json`：起始与终态筛选清单。
- `details-*.json`：商品详情快照。
- `official-recommendations-*.json`：平台动态推荐。
- `planning/index.json` 和每商品计划。
- `direct-*-result.json` / `poc-*-result.json`：提交与回读证据。
- `direct-batch-checkpoint.json`：断点状态。
- `barcode-scan.json`：同 SPU 图片条码识别、GTIN 校验与未命中证据。
- `no-upc-*/<spu>.json`：满足通用无品牌商品证据门的单 SKU 无条码计划；必须包含
  原条码保护、扫描图片数量和网页检索证据。
- `special-picture-candidates-*.json`：同 SPU 与完整标题图库候选的低敏快照。
- `authentic-special-picture-*/index-part-*.json`：最多 10 SPU 的 OCR 证据计划分片。
- `image-cache/`：候选图片去重缓存；OCR 分片必须共享，避免重复下载。
- `events.jsonl`：低敏事件。
- `change-ledger.csv`：可选的内部字段事件中间件，不是用户交付格式；最终只允许统一七表工作簿。

不要在这些文件中保存 Cookie、签名、Authorization、手机号、验证码或完整请求头。

## 标签与内存门禁

- 所有未来 `apply-direct-batch` 必须使用 `scripts/run_qnh_batch.sh`，不得直接运行 `node scripts/qnh_direct.mjs apply-direct-batch`。单进程显式传稳定 `--offset` 与 `--limit 1..50`，大于 50 在 CDP 连接前失败关闭。实际 writer 统一默认 1，只在同量端到端 canary 更快且资源健康时按 `1→2→4` 升档，4 为硬上限。
- 4.3.0 worker pool 的资源口径固定为“Node RSS + 相对批次启动时浏览器 renderer 基线的新增 RSS”，并同步记录浏览器总 RSS 和宿主 MemAvailable。不能再用 Node RSS 很小推断 Chrome 工作页也很小；达到压力门后停止取新商品，关闭本批工作页后由下一子进程续跑未终态 SPU。
- 新工作页只允许通过单飞队列依次创建并预热；可拦截 image/media/font，禁止拦截 script/stylesheet/xhr/fetch/H5guard。每个目标 SPU 仍必须取得当前精确编辑页原生 detail 证据后才能写。
- 新浏览器必须使用 `scripts/start_qnh_browser.sh`。浏览器和批处理会进入 `yuandian-automation.slice`；`systemd-run`、sudo 或 slice 不可用时失败关闭，绝不回退到无上限 `ssh.service`。
- admission 默认要求 `MemAvailable >= 6 GiB`、automation slice 内存 `< 4.5 GiB`、一秒 swap-in `<= 1 MiB/s`。拒绝只影响新启动；不得为了通过门禁终止、迁移或重启已有 Node、Chrome、Codex 或业务服务。
- 峰值 4 路出现压力后先粘滞到 2；若 2 路仍在少量商品后触发软回收，则下一次固定用 1 个可复用热 worker 跑完整
  窗口。外层 admission 仍按共享安全合同以 2 做 cgroup 准入，进入边界后由 Skill 恢复已冻结的 serial 决策；不得
  修改项目级 runtime guard，也不得把 serial 恢复误报为配置上限失效。
- admission 的 75/76/77 不代表平台请求失败；连续编排器每 15 秒重新只读准入，复用原 checkpoint。已验证行不重复
  保存，mutation failed/unknown 仍等待独立回读。
- 启动批次后先运行 `node scripts/qnh_direct.mjs close-edit-tabs --run-dir "$RUN_DIR"`。
- 每个 SPU 的 UI 保存与回读完成后，关闭其 `商品主档编辑` 内部标签再进入下一条。
- dry-run、页面检查或单条失败在截图/日志留证后也关闭对应标签。
- 常驻标签只保留 `首页` 与 `商品主档`。`remaining_count` 不为 0 时停止继续打开商品。
- Chrome 页面数或内部编辑标签数持续增长时立即暂停，先清理并核对内存占用。

## 异常处理

- 登录过期：暂停提交，保留 checkpoint，让用户重新登录，然后重新 `preflight`。
- 商品审核中：记录当前审核状态；不要用重复提交规避平台审核。
- 平台异步审核未结束：保存回读成功与审核出队分开统计；等待用户后续要求再复扫，
  只处理新增原因，不重复写已物化字段。
- 活动冲突：保留活动关系，走更新商品路径；将平台返回写入结果。
- 单商品校验失败：记录失败字段与页面提示，继续下一个商品；修正规则后只重跑失败项。
- HTTP 成功但回读不一致：视为失败，不删除证据，不计入完成数。
- CDP/tenant/store 不一致：立即标记 `invalid_wrong_session`；当前列表总数、详情和交集不得用于汇报，
  图片上传与商品保存均零发送，重新绑定用户指定会话后再冻结。
- 专项图顶层回读与编辑页不一致：核对 canonical pictureType、实际保存请求和刷新后槽位；
  标品库商品点击保存零请求或刷新后图片消失时标记受限，不计物化成功。
- 无条码保存：除空条码列表外必须回读 `customizeNoUpcCode=1`；旧条码与计划不一致时
  立即停止该 SPU，防止覆盖人工新值。
- 页面结构变化：先只读抓一个商品和 UI 截图，定位新字段契约，再做单商品 dry-run。
- OCR 资源竞争：同机多个账号不得同时提高 Tesseract 并发；每账号最多 4 workers，
  推荐账号间串行。40 SPU 长进程被 SIGTERM 时不要整批重跑，保留共享图片缓存并改为
  10 SPU 独立分片和独立 index。

## 终态数字

最终至少给出：

1. 起始筛选商品数和唯一 SPU 数。
2. 尝试商品数、提交成功数、回读成功数、失败数。
3. 修改字段总数，按字段类型和证据来源拆分。
4. 已退出原筛选列表数。
5. 仍不可售数及原因分类。
6. 资质图新增数、无真实材料而未处理数。
