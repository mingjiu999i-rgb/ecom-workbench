import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const automationDir = path.dirname(fileURLToPath(import.meta.url))
export const localDir = path.join(automationDir, '.local')
const configPath = path.join(automationDir, 'accounts.local.json')
const exampleConfigPath = path.join(automationDir, 'accounts.example.json')

export const homeUrl = 'https://mms.pinduoduo.com/home/'

export async function loadAccounts() {
  let raw
  try {
    raw = await fs.readFile(configPath, 'utf8')
  } catch {
    throw new Error(`缺少本地账号配置：请复制 ${exampleConfigPath} 为 ${configPath}`)
  }
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed.accounts)) throw new Error('accounts.local.json 格式不正确')
  return parsed.accounts.filter(account => account?.id && account?.name && account.enabled !== false)
}

export function selectedAccount(accounts) {
  const index = process.argv.indexOf('--account')
  const requested = index >= 0 ? process.argv[index + 1] : accounts[0]?.id
  const account = accounts.find(item => item.id === requested)
  if (!account) throw new Error(`找不到账号 ${requested || '（空）'}`)
  return account
}

export function yesterdayText() {
  const date = new Date()
  date.setDate(date.getDate() - 1)
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
}

async function devtoolsEndpoint(port, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode != null) throw new Error('Chrome 启动后立即退出')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return await response.json()
    } catch {
      // Chrome 调试端口尚未就绪。
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('等待 Chrome 本机调试端口超时')
}

export async function launchAccount(account) {
  const profileDir = path.join(localDir, 'profiles', account.id)
  const downloadsPath = path.join(localDir, 'downloads')
  await fs.mkdir(profileDir, { recursive: true })
  await fs.mkdir(downloadsPath, { recursive: true })
  const port = await freePort()
  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const child = spawn(chromePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--start-maximized',
    homeUrl,
  ], { stdio: 'ignore' })
  const endpoint = await devtoolsEndpoint(port, child)
  const browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl)
  const context = browser.contexts()[0]
  const page = context.pages()[0] || await context.newPage()
  page.setDefaultTimeout(20_000)
  const closeBrowser = async () => {
    await browser.close().catch(() => undefined)
    if (child.exitCode == null) child.kill('SIGTERM')
  }
  return { browser, child, context, page, downloadsPath, closeBrowser }
}

export async function firstVisible(locator) {
  const count = await locator.count()
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index)
    if (await item.isVisible().catch(() => false)) return item
  }
  return null
}

export async function clickText(page, text, options = {}) {
  const locator = page.getByText(text, { exact: options.exact ?? true })
  const item = await firstVisible(locator)
  if (!item) throw new Error(`页面上找不到“${text}”`)
  await item.click()
  return item
}

export async function waitForLogin(page) {
  await page.goto(homeUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  const body = await page.locator('body').innerText().catch(() => '')
  if (!body.includes('商家后台') || body.includes('登录账号')) {
    throw new Error('该账号登录状态已失效，请先运行 npm run pdd:login 并完成人工验证')
  }
}

export function safeName(value) {
  return String(value).replace(/[\\/:*?"<>|]/g, '_')
}

export async function saveFailure(page, account, stage) {
  const failureDir = path.join(localDir, 'failures')
  await fs.mkdir(failureDir, { recursive: true })
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const target = path.join(failureDir, `${account.id}_${safeName(stage)}_${stamp}.png`)
  await page.screenshot({ path: target, fullPage: true }).catch(() => undefined)
  return target
}
