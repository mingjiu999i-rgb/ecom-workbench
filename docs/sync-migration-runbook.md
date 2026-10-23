> 历史诊断/设计文档：以下保留最初排查和方案背景。生产行表已安装、迁移并启用；当前线上已通过 Windows 真实读取与保存，Mac 跨设备尚未验收。当前状态以 [上线说明](sync-release-2026-10-23.md) 为准；不要把历史安装/导入步骤直接重跑。

# 迁移、切换与回滚手册（生产步骤等待批准）

## 已完成与禁止误用

本次只生成/测试 SQL 和本地代码。`supabase/proposals/202610220001_workbench_rows.sql` 故意放在 proposals 而非自动 migrations 中，避免常规 db push 自动执行。没有触碰生产记录、配置、计费或部署。

不要将当前根目录旧源码发布；使用经过校验的隔离源码或把交付补丁应用到相同远程基线，再重新检查远程增量。不要提交含真实经营数据的备份、bundle 或生成的私有 SQL。新回执和暂存也属于经营数据。

## 先进行只读检查

操作员在低峰期从 SQL Editor **逐节**执行 `supabase/diagnostics/sync-read-only.sql`，每段只读事务、5 秒语句/500 ms 锁超时。先核对线上实际函数和权限，再判断是否启用 pg_stat_statements；未启用则只记录不可用，不为本任务重启/安装。不要 EXPLAIN ANALYZE、全表展开 JSONB、重置统计或反复导出大文档当健康检查。

从 Dashboard 记录同一 UTC 窗口的 CPU、内存、磁盘、连接/池队列、PostgREST 500 和 PostgreSQL 重启/超时日志；展示时转北京时间。本地基准不能代替这些结果。SQL 查询文本分享前脱敏。

## 隔离演练（本地可立即重跑）

在隔离源码目录运行：

```powershell
npm ci
npm test
npm run build
node tools/benchmark-workbench-rows.cjs
```

只在本地导出数据副本，先保留原文件只读，再执行（输出文件必须尚不存在）：

```powershell
node tools/prepare-workbench-row-migration.cjs raw-document.json NEW-bundle.json
node tools/write-workbench-row-import.cjs NEW-bundle.json ACCOUNT_UUID EXPECTED_UPDATED_AT NEW-private-import.sql
```

输入必须是数据库 **原始 data 对象**，不能使用前端 normalize 后的展示值冒充原文。EXPECTED_UPDATED_AT 从同一次原文导出取得，保持完整时间精度。工具不连接数据库、不读取密钥；重复身份、坏校验和、覆盖现有输出都会失败。

先在独立 PostgreSQL/Supabase 测试库安装原有迁移与 proposal，再审阅并执行生成的 SQL。生成器仅插入空 shadow 目标；验证旧原文及 updated_at 必须同时相等，持有旧表写入屏障；事务失败全回滚。原始 data 不修改。每条 INSERT 最多 200 行，但全迁移仍是一个事务，低配置实例上是否可承受需要用脱敏真实结构样本验证；超时停止，不能无限延长超时。更大规模的可恢复 shadow 分段回填需要另行实现并审阅。

从新表导出当前账号所有行，移除外围 user_id（或只选 codec 字段），执行：

```powershell
node tools/prepare-workbench-row-migration.cjs raw-document.json NEW-verified-bundle.json exported-rows.json
```

要求完整字段、记录数、业务身份、数组顺序、成本快照、所有原始金额（含 null）完全一致，SHA-256 校验一致；再跑既有结算与新迁移测试。任一差异都停止，不改公式或补造值。

## 生产安装与正式切换：逐项人工批准后执行

1. 审批 A：批准只安装 additive proposal。安装前保存 schema/function/policy 定义与可恢复备份，检查无同名新对象。无 head 的账号仍走旧路径。安装 DDL/触发器也可能短暂等锁，须维护窗口、短锁超时，失败回滚。
2. 所有设备先导出尚未同步草稿，记录账号与云端原文版本；不要清理 IndexedDB。确认旧写入口清单：delta、patch、直接 REST/脚本、旧离线浏览器。
3. 审批 B：批准指定账号迁移/停写窗口。确认隔离测试的 authenticated/anon/RLS、并行连接、批量限制和真实结构比对结果。生成 SQL 按当前旧快照导入 shadow；此前若旧写发生，版本校验失败即重新取样，不覆盖新旧数据。
4. 切换采用操作员事务：**先**取得 `LOCK TABLE public.workbench_documents IN SHARE ROW EXCLUSIVE MODE` 写屏障，再锁该账号 head，核对旧文档 `updated_at` 与迁移版本、原文一致，确认 shadow 行数/校验；然后把 mode 设为 frozen 并提交。不得先拿 head 再等待旧文档锁，避免与旧 RPC 的锁顺序相反。旧数据若已变更则退出、保留 shadow，不进行切换；不要悄悄覆盖 shadow 重新尝试。
5. frozen 后再导出最终两侧并比对，核对各设备未同步备份。迁移窗口保留旧文档与本机备份，禁止双写。没有确认差异的本地草稿只允许导出/人工恢复，不能自动当成新库完整真相。
6. 审批 C：批准指定构建的 `VITE_WORKBENCH_STORAGE=rows-v1` 和发布计划（本次尚未设置/部署）。新构建只允许行存储读写；服务端仍 frozen 时应拒绝，不能回退。确认应用版本和业务结果后，操作员将指定账号 head 改 rows，刷新/重新登录验证实际 authenticated 保存。若一次发布覆盖所有账号，必须全部完成 head 迁移，否则未迁移账号会明确失败；本实现不是按账号灰度路由。
7. 联测 Mac、Windows 的同/不同记录冲突、离线恢复、刷新和重新登录、实际 500/响应丢失注入，以及旧客户端重新上线。旧客户端写入应返回 40001，保留本机草稿；它仍可能读到保留的旧文档，不能被当成最新数据。
8. 持续观察至少一个完整业务结算周期（建议 14 天）。记录成功率、延迟、失败/重试、慢语句、资源指标和每次变化行数。旧文档、迁移包、各设备备份与回执继续保留，另行批准清理。

## 回滚

- 切换前：停用未启用的客户端门禁，shadow 仅作核对；旧库完整保留。新对象不必立即删除。
- 切换后：先停止客户端新写，把账号设 frozen；导出全部新行、head、回执与本机草稿，确认无在途提交。无损 decode 重组 **包含切换后变化** 的新文档，逐字段/金额/业务键核对后再准备操作员 CAS 回写脚本。
- 回写在维护事务内先锁旧表屏障和相关 head，重新核对 frozen revision；经批准暂改 shadow 允许操作员回写最新重组文档，再恢复旧格式的 updated_at 和 last_sync_request 兼容状态。所有步骤原子提交，客户端仍维护停写。不要直接运行旧备份覆盖。
- 重新发布旧模式需要独立批准。各设备的未同步草稿必须再次人工核对，不得自动恢复旧快照；新表、回执及冻结导出继续保存，先验证实际保存和结算再解除维护。
- 此处刻意没有一键生产回滚 SQL：回滚输入必须是切换后实际最新数据和版本；审批时才生成具备该版本断言的具体脚本。异常、权限错误或金额差异一律停止。

## 后续维护门禁

暂存失败可重试，不可见半成品。孤立/过期未提交批次与回执没有自动清除；需观察量、保留期限、备份与审批后再做小批清理。回执一旦删除就可能失去较早响应丢失的确认能力；不能随意清空。高频真实导入超过 8 MiB 原子批次应先停下评估业务事务边界，不进行无控制拆批提交。
