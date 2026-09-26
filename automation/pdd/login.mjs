import { homeUrl, launchAccount, loadAccounts, selectedAccount } from './lib.mjs'

const accounts = await loadAccounts()
const account = selectedAccount(accounts)
const { browser, child, page } = await launchAccount(account)

console.log(`正在打开账号：${account.name}（${account.id}）`)
console.log('请在打开的 Chrome 中完成登录、指纹或短信验证。确认进入商家后台首页后，直接关闭这个 Chrome 窗口。')

await page.goto(homeUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined)
await new Promise(resolve => {
  browser.on('disconnected', resolve)
  child.on('exit', resolve)
})
console.log(`已保存 ${account.name} 的本地 Chrome 登录状态。`)
