# 拼多多订单自动下载（本地）

该脚本只在本机运行，使用独立的可见 Chrome 配置保存登录状态。它不会保存账号密码，也不会绕过指纹、短信或验证码。

## 1. 配置账号

复制 `accounts.example.json` 为 `accounts.local.json`，为每个账号设置唯一 `id` 和店铺名称。`accounts.local.json`、Chrome 登录资料和下载结果均被 Git 忽略。

## 2. 首次登录

```bash
npm run pdd:login -- --account pdd-01
```

在打开的 Chrome 中完成登录和验证。进入拼多多商家后台首页后关闭窗口。

## 3. 下载昨日数据

```bash
npm run pdd:download -- --account pdd-01
```

成功后会在 `automation/pdd/.local/downloads/<账号>/<日期>/` 保存订单 CSV 和 `download-summary.json`。后者包含从首页读取的昨日推广费。

第一版按“一个店铺只运营一个产品”处理，推广费全部计入该店铺对应产品。多产品店铺需要商品级推广明细或另行确定分摊规则。
