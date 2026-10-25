> 历史诊断/设计文档：以下保留最初排查和方案背景。生产行表已安装、迁移并启用；当前线上已通过 Windows 真实读取与保存，Mac 跨设备尚未验收。当前状态以 [上线说明](sync-release-2026-10-23.md) 为准；不要把历史安装/导入步骤直接重跑。

# 云端同步诊断（第一阶段，2026-10-22）

## 范围与证据

已逐文件校验远程 main `49e431b5246492c35bb9331b2598e06bfaba0539` 的 97 个 Git blob。隔离源码位于 `.work/sync-storage-optimization/source`；根工作目录 HEAD 为 `2f4a364`，存在历史未提交内容，不作为本次发布来源。本报告先于本次代码优化完成。未连接生产数据库执行 SQL、未更改配置、未部署。

约 26.8 MB 文档、500、超时和异常重启由用户报告。工作区已有 `.work/sync-resilience-20261022/INCIDENT.md` 记录相关旧排查，但本次未重新取得云端指标，不能把历史材料当作当前测量。没有证明 OOM、连接池耗尽或具体锁等待是重启根因。

以下行号基于上述远程提交（本次修改前）。

## 真实结构与调用链

`supabase/migrations/202609080001_create_workbench_documents.sql:1`：唯一业务表 `public.workbench_documents`，`user_id uuid PRIMARY KEY REFERENCES auth.users`、`data jsonb`、`updated_at timestamptz`。`202610210001_add_atomic_workbench_delta.sql:4` 添加 `last_sync_request jsonb`。RLS 按 `auth.uid() = user_id` 隔离账户；甲方、店铺并非独立数据库租户，而在文档中通过 ID 关联。已有 user_id 主键足以支持账号定位；updated_at 索引不能减轻 JSONB 重建。

`src/types/models.ts:60` 的 WorkbenchData 包括：

| JSON 路径 | 内容和实际身份 |
|---|---|
| clients / stores / products / productLinks / productCosts / skus | 基础资料，记录 id；store.clientId、link.storeId 等关联 |
| operations / skuHistory / todos | 运营调整、价格历史、待办，id |
| profitRecords / collectionRecords | 商品日利润、经营日结算；实际保存键含店铺、日期、商品，保留原 id |
| orderAccountingLedgers[] | 每店账本：storeId、initializedDates、orders、refunds、funds、promotions |
| ledger.orders[] | id、date、receipt、cancelled、quantity、productId、unitCost（可 null 的历史成本快照）、supplement |
| ledger.refunds[] | id、orderId、success、stage、amount；同退款 id 的状态会更新 |
| ledger.funds[] | key、orderId、income、expense、businessCode、category；key 为报表指纹加同值行序号 |
| ledger.promotions[] | date、amount；店铺内按日合并 |
| linkSalesOrders（扩展字段） | storeId + orderId；商品 ID、规格、SKU 编码、付款日和金额，金额/日期可能未知 |
| linkSalesPromotions（扩展字段） | storeId + goodsId + date，独立页面手填推广费 |
| overviewRefundActivity / skuPlanningDrafts（扩展字段） | 总览退款观察记录、SKU 规划草稿 |

`src/utils/pddLedger.ts:26-74` 用订单 id、退款 id、流水 key 在单店范围去重，保存历史 unitCost；不得改其规则。`src/pages/PddAnalyzer.tsx:159` 生成资金指纹及序号；`:212` 调 preparePddAccounting；`:219-222` 保存商品 ID 索引；`:261-282` 延迟 600 ms 一次更新账本和两个汇总数组。订单号不能跨店作为全局主键。

调用链：页面 `useWorkbench().update(recipe)` → `src/store/workbench.tsx:91` 对最新 dataRef 执行 recipe、跳过内容未变 → `createWorkbenchSync.enqueue`（`src/utils/workbenchSync.ts:111`，300 ms 合并）→ IndexedDB 完整草稿 → `saveWorkbench`（`src/services/supabase.ts:79`）→ `buildWorkbenchDelta` → `rpc/save_workbench_delta` → `SELECT ... FOR UPDATE` → `_workbench_apply_delta` → **UPDATE workbench_documents SET data=result**。

初始化/加载：`supabase.ts:60-76` 查询整个 data 与 updated_at，没有文档则保存模板。normalizeWorkbench 只在前端加载时做已有兼容处理。内存 storedSnapshots/storedRevisions 保存最后确认的原文与版本。`workbench.tsx:63-78` 同时读取云端与本机备份，通过 `workbenchRecovery.ts:44` 比较，差异必须人工选择，绝不自动合并或用零补未知值。

本机备份：`src/services/workbenchDrafts.ts:5-77` 的 IndexedDB `ecom-workbench-local-drafts/pending`，按 userId 一份完整快照；删除/确认先比较 draft id，避免旧成功响应清理新草稿。关闭页只弹离开警告，不依赖 unload 上传。备份失败显示错误但云端保存仍继续；突然关机发生在 IndexedDB 完成前，不能保证最后一笔编辑持久化。多个标签页共享同一 userId 草稿槽，可能相互覆盖，需独立后续处理。

## 已确认问题

1. **传输增量不等于存储增量。** `202610210001_add_atomic_workbench_delta.sql:83-98` 锁账号行并取整个 data，递归计算新 JSONB，再更新该大型字段。`:27` 的对象 jsonb_set 和 `:56-68` 的数组重建均可能放大处理。单 SKU 更新也会走此路径。PostgreSQL 不会因此原地修改 TOAST 中某个 SKU 的字节。具体 WAL、物理页写入量本次未测。
2. **账号级锁涵盖大文档处理。** 同账号多个设备争用同一行；这是代码可确认的串行点，但真实等待时长未知。增加索引无法解决这个串行点。
3. **兼容降级削弱防覆盖。** `supabase.ts:109-128` 遇到 PGRST202 降到旧 patch（不验证 expected revision），再降到 full upsert；缺少 revision 也走 patch。初始化也使用 upsert，初次并发建档存在覆盖窗口。新方案应失败后保留备份，而不是无条件覆盖。
4. 重试次数有限，但采用固定 1/3/10/30/60 秒（连接故障）或 1/3 秒（普通失败），没有随机抖动；多个设备同时恢复可能同时重试。
5. 本机 enqueue 每次都排队写完整 IndexedDB 草稿，网络防抖没有合并本机写盘；对大文档有浏览器开销，不能未经耐久性测试直接删掉这些备份。
6. last_sync_request 只记最后一次成功请求。同设备同数据对象的重试使用同 UUID；若成功响应丢失后另有写入，再重试旧操作将冲突，而不是重复应用。这是安全保守失败，但不能自动确认较早已成功请求。

## 已有保护与未确认问题

单个 Provider 有 running 控制，不会在正常组件生命周期中同时发两个保存；没有发现多个页面绕过 Provider 直接写库。累计 recipe 对最新状态操作，快速编辑合并保留不同记录。只读 summary 注册不会写；页面存在导入后有条件自动保存，不能笼统称为只读误保存。StrictMode 开发环境重复加载和生命周期交界仍需真实浏览器验证。

40001 冲突不会自动重试，不静默覆盖。服务已提交但响应丢失确实可能发生；相同 request id 且仍为最新版本时 RPC 只返回确认。断网/超时保留草稿，自动重试有上限；online/manual retry 可开始新的有限轮次。连续新编辑会重置 attempts，持续故障时仍可能持续请求，需账号级节流。

未确认：线上实际 SQL 函数是否与仓库相同、pg_stat_statements 是否启用、慢语句次数、锁等待、活动/池连接数、内存压力、WAL/TOAST 写放大、重启原因、26.8 MB 中各字段比例、历史数据重复比例。linkSalesOrders 与账本都存部分订单信息是**不同用途**的重叠：账本缺规格/商品原始链接信息，不能随意删除索引或从账本伪造它。退款/流水原始发生时间并非都已持久化，不能补造日期；分页日期索引仅可使用已保存值。

## 优先三个瓶颈与决定

1. 大 JSONB 整体重建与账号锁：采用 B 的渐进式行存储，本地原型先证明逐行修改与无损重组。
2. 大导入和超时后的重复处理：分批暂存、一次事务确认，稳定请求身份及独立回执；旧文档保持原样。
3. 不安全降级与故障请求聚集：本地先移除无版本降级、补抖动与账号串行入口，保持现有备份和冲突提示。

方案 A 只能缓解请求，不能宣称解决大型 JSONB 重写。不要重复尝试增加 authenticated timeout 或修改业务计算。

## 推荐影响范围与迁移风险

保持业务组件、结算计算、导入去重、历史快照、导出不变。新的纯存储 codec 保留所有字段、数组顺序、null 与零，使用账号 + 集合 + 店铺作用域 + 原始业务身份定位记录。少量存储表承载多类对象；按真实店铺、日期字段建立组合索引；未知字段独立保留。一个账号的小版本行维持保守 CAS，跨设备不同记录先冲突、保留草稿，暂不推行自动业务合并。

新表显式授权，authenticated 只能读取自己行，通过校验 auth.uid() 的受控 RPC 写入；RLS 与越权测试必须通过。批量上传可暂存，只有完整批次的原子提交可见；跨表相关的账本和汇总不能逐批可见。

生产步骤须单独批准：只读核实结构/函数/权限 → 导出旧文档与各设备未同步备份 → 隔离库安装新表并迁移脱敏真实结构样本 → 逐字段和记录身份/关键金额比对 → 维护窗口冻结旧写入（包括旧 RPC、直写、离线设备）→ 基于最新旧版本重迁移并比对 → 明确切换客户端与服务端模式 → 观察。禁止无控制双写。当前报告不授权运行生产迁移。

回滚：切换前停用新路径即可，旧文档未改；切换后须冻结新写入、完整导出新行存储含切换后新增修改，再经无损重组和金额核对回写兼容文档，调整门禁后恢复旧客户端。不得直接恢复旧快照。旧文档、迁移清单、本机未同步备份、请求回执保留观察期；没有批准不得清除。冲突、重复身份、未知字段过大、金额差异均停止切换，不更改业务公式。

后续交付：隔离源码中的 `docs/sync-storage-design.md`、`docs/sync-migration-runbook.md`、`docs/sync-performance-report.md`、`docs/sync-open-issues.md` 和只读诊断 SQL。生产性能验收与真实 Mac/Windows 联测属于批准后的门禁，不能由本地模拟冒充。
