> 历史诊断/设计文档：以下保留最初排查和方案背景。生产行表已安装、迁移并启用；当前线上已通过 Windows 真实读取与保存，Mac 跨设备尚未验收。当前状态以 [上线说明](sync-release-2026-10-23.md) 为准；不要把历史安装/导入步骤直接重跑。

# 同步优化方案与本地实现

基线：远程 main `49e431b5246492c35bb9331b2598e06bfaba0539`。诊断见 `sync-optimization-audit.md`。未执行生产迁移、切换、配置或部署。

## 当前默认路径的加固

`src/services/supabase.ts` 保持当前 delta RPC、版本检查、既有加载规范化、完整草稿和恢复界面。增加每账号保存队列；PGRST202/缺版本直接失败，禁止降到无 CAS 的 patch/full upsert；初始化使用 insert 防止两个首次登录相互覆盖。失败不会前移确认基线。

`src/utils/workbenchSync.ts` 使用有上限的指数退避和 50%–100% 随机抖动；普通暂时故障两次重试，连接故障五次。重试预算属于同步管理器中的账号，连续新编辑不会清零预算或绕过冷却；耗尽后保留最新完整草稿，需在线恢复事件或人工重试再启动有限轮次。备份错误、清理错误、超时提示及冲突保留。

这部分不消除现有数据库 JSONB 重建；只有完成下面的双重门禁切换才消除。

## 行存储边界

只有明确构建 `VITE_WORKBENCH_STORAGE=rows-v1`，且服务端该账号 `workbench_heads.mode='rows'` 时才启用新路径。默认配置仍走旧版有版本保护的路径；本次没有设置生产变量。新模式加载或写入失败绝不回退读取/覆盖旧文档。Provider 的业务 API、加载规范化与本机备份恢复保持原有行为。

四张表：

| 表 | 用途 |
|---|---|
| workbench_heads | 每账号 mode、bigint revision（线传为字符串），小行 CAS 锁 |
| workbench_rows | 多种集合共用行存储，原始记录 body JSONB、position、查询辅助字段 |
| workbench_row_batches | 请求 UUID、版本、SHA-256 描述指纹、记录数、已提交 revision；持久幂等回执 |
| workbench_row_staging | 分批上传操作，成功提交前对业务查询不可见 |

行主键为 `(user_id, collection, scope, record_key)`。codec `workbenchRows.ts` 不参与业务去重：基础数组保留 id；单店账本 scope 为原 storeId 的 JSON 编码，订单/退款用原 id，资金用原 key（含同值行序号），推广费用原 date。商品 ID 索引用 `[storeId,orderId]`，手填推广费用 `[storeId,goodsId,date]`。重复身份不丢弃，直接阻止迁移并报告。跨店同订单/编码仍独立。

`position` 保持原数组顺序；删除/重排可能改多行，这是正确保序的代价。`$array` 保留空数组和字段存在性，`$value` 独立保存未知对象字段；未知扩展数组按位置保留，不发明业务身份。账本元数据行保留 initializedDates 和所有未知字段，只有四类明细数组被拆开。还原后重新编码严格比对，缺页、孤儿、错序和未知存储格式不能被静默丢掉。未知日期/金额保留 null/缺失，成本快照不从今日成本表补算。

store_id/client_id/business_date 为已有字段的查询投影，不是新的结算事实；缺少真实日期的退款、资金不赋予虚构发生日。现有父子关系和孤立历史行不强加会破坏兼容的业务外键。账号外键、主键和批次唯一约束由数据库保证。

主键支持账号及集合读取；`(user_id,store_id,business_date,collection)`、`(user_id,client_id,business_date,collection)` 支持已有店铺/甲方/日期投影查询。当前适配层为兼容页面仍按 500 行主键游标加载完整快照，前后读取版本以拒绝混合快照；写后只接收小回执，不重读历史。首次全量加载、前端内存和 O(N) 差异计算仍有成本。

## 提交、并发和权限

调用链：保存累计快照 → 无损编码/比较 → 没变化则零写入 → SHA-256 描述 → begin → 每批最多 200 操作、客户端 256 KiB（服务端 JSONB 文本上限 512 KiB）stage → commit。服务端整个原子批次最多 100,000 操作且 8 MiB 暂存文本，超限显式保留本机草稿；不能拆成会暴露一半账本/汇总的多个提交。

stage 的操作序号与身份都有唯一约束，同 UUID 同位置的不同内容被拒绝。commit 检查完整性、账号模式和 expected revision，一次事务执行变化行的删除/upsert、小版本前移和回执登记，再清理暂存行。无变化的数据库行通过 IS DISTINCT FROM 排除。不会访问旧 JSONB。行存储不意味着完全无锁：同账号依旧保守串行，只把锁内工作缩小到变化记录。

同记录或不同记录的跨设备陈旧版本都返回 40001，保留原草稿，暂不做自动三方业务合并。单设备累计编辑、多个调用入口由队列串行。丢失响应时先确认原 UUID 回执，再处理更新的本机快照；回执在后续保存后仍可查询确认。返回的数据与内部基线分离，防止引用修改漏判。

authenticated 显式 SELECT 自己的 head/rows/batch，anon 无权限，staging 没有直接读取授权；所有表启用 RLS。authenticated 无直接写权限，不能绕开版本 CAS；写 RPC 使用 security definer、空 search_path、固定 auth.uid() 过滤，不接受外部 user_id。辅助读取 RPC 为 security invoker。浏览器只复用正常登录的 anon-key 客户端，没有 service_role。维护性迁移只能由批准后的操作员执行。

旧文档 BEFORE 写触发器在 rows/frozen 模式返回 40001，拦截旧 delta/patch/直写及离线旧客户端。shadow 不阻止旧写。全局切换必须用维护锁和最新版本核对，见运行手册；安装 schema 自身不代表切换完成。

## 自动验证范围

已有 214 项基线测试全部先通过。新增 codec、真实本地 PostgreSQL SQL/RLS、批次原子性、幂等回执、路由门禁、迁移 SQL 和既有业务函数前后比较。精度/舍入沿用既有函数；逐字段比较进一步保证 null/零/历史值一致。未修改任何经营公式。

真实 Mac/Windows、生产 PostgREST/Supavisor、并行 PostgreSQL 连接的锁行为和真实数据迁移仍需隔离环境验收。PGlite 是真实 PostgreSQL SQL 引擎，但不能替代实际部署验证。
