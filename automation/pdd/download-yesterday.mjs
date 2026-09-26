import fs from 'node:fs/promises'
import path from 'node:path'
import {
  clickText,
  firstVisible,
  homeUrl,
  launchAccount,
  loadAccounts,
  safeName,
  saveFailure,
  selectedAccount,
  waitForLogin,
  yesterdayText,
} from './lib.mjs'

const accounts = await loadAccounts()
const account = selectedAccount(accounts)
const targetDate = yesterdayText()
const { closeBrowser, context, page: initialPage, downloadsPath } = await launchAccount(account)
let page = initialPage
let stage = '打开商家后台'

async function selectYesterday() {
  stage = '设置昨日筛选'
  const body = await page.locator('body').innerText()
  if (body.includes(`${targetDate} 00:00:00`) && body.includes(`${targetDate} 23:59:59`)) return

  const presetInputs = page.locator('input[value="近90日"], input[value="今日"], input[value="昨日"], input[value="近7日"], input[value="近30日"]')
  const preset = await firstVisible(presetInputs) || await firstVisible(page.getByText(/^(近90日|今日|昨日|近7日|近30日)$/))
  if (!preset) throw new Error('找不到订单下单时间快捷筛选')
  await preset.click()
  await page.waitForTimeout(800)

  const yesterday = await firstVisible(page.getByText('昨日', { exact: true }))
  if (!yesterday) throw new Error('展开日期筛选后找不到“昨日”选项')
  await yesterday.click()
  await page.waitForTimeout(1200)
}

async function scrapeYesterdayPromotion() {
  stage = '读取昨日推广费'
  await page.goto(homeUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  const body = await page.locator('body').innerText()
  const promotionBlock = body.match(/推广花费\s*\n\s*[¥￥]?([\d,.]+)\s*\n\s*昨日\s*[¥￥]?([\d,.]+)/)
  if (!promotionBlock) throw new Error('首页没有识别到“推广花费/昨日”数据')
  return Number(promotionBlock[2].replaceAll(',', ''))
}

async function openOrders() {
  stage = '进入订单查询'
  const candidates = page.getByText('订单查询', { exact: true })
  const count = await candidates.count()
  for (let index = count - 1; index >= 0; index -= 1) {
    const candidate = candidates.nth(index)
    if (!await candidate.isVisible().catch(() => false)) continue
    await candidate.click()
    await page.waitForLoadState('domcontentloaded').catch(() => undefined)
    const exportButton = page.getByText('批量导出', { exact: true })
    if (await exportButton.first().waitFor({ state: 'visible', timeout: 60_000 }).then(() => true).catch(() => false)) {
      const modal = page.locator('[data-testid="beast-core-modal"]').first()
      if (await modal.isVisible().catch(() => false)) {
        const closeSelectors = [
          '[data-testid*="close"]',
          'button[class*="close"]',
          '[class*="closeIcon"]',
          '[class*="close"]',
        ]
        for (const selector of closeSelectors) {
          const close = modal.locator(selector).first()
          if (!await close.isVisible().catch(() => false)) continue
          await close.click()
          break
        }
        await modal.waitFor({ state: 'hidden', timeout: 5000 }).catch(async () => {
          const container = page.locator('[data-testid="beast-core-modal-container"]').first()
          const box = await container.boundingBox()
          if (box) await page.mouse.click(box.x + box.width - 4, box.y + 4)
        })
        await modal.waitFor({ state: 'hidden', timeout: 5000 })
      }
      await page.waitForTimeout(1200)
      const allOrders = await firstVisible(page.getByText(/全部订单\s*\(近3个月\)/, { exact: true }))
      if (allOrders) {
        await allOrders.click()
        await page.waitForTimeout(1800)
      }
      return
    }
  }
  throw new Error('点击“订单查询”后没有进入订单列表')
}

async function generateReport() {
  await selectYesterday()
  stage = '查询昨日订单'
  let orderCount = 0
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const queryButton = await firstVisible(page.locator('button').filter({ hasText: /^查询$/ }))
    if (!queryButton) throw new Error('找不到蓝色“查询”按钮')
    await queryButton.click()
    await page.waitForTimeout(10_000)
    const body = await page.locator('body').innerText()
    const match = body.match(/共查询到\s*(\d+)\s*个订单/)
    orderCount = Number(match?.[1] || 0)
    if (orderCount > 0) break
  }
  if (!orderCount) throw new Error(`${targetDate} 查询结果仍为0，未继续生成空报表`)

  stage = '打开批量导出'
  await clickText(page, '批量导出')
  await page.getByText('批量导出订单', { exact: true }).waitFor({ state: 'visible' })

  stage = '选择对账报表'
  const reconciliation = await firstVisible(page.getByText('对账报表', { exact: true }))
  if (!reconciliation) throw new Error('导出窗口中找不到“对账报表”')
  await reconciliation.click()
  await page.waitForTimeout(500)

  const gotIt = await firstVisible(page.getByText('我知道了', { exact: true }))
  if (gotIt) {
    await gotIt.click()
    await page.waitForTimeout(500)
  }

  stage = '生成报表'
  await clickText(page, '生成报表')
  const generated = page.getByText('查看已生成报表', { exact: true })
  await generated.waitFor({ state: 'visible', timeout: 60_000 })
  const reportPagePromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null)
  await generated.click()
  const reportPage = await reportPagePromise
  if (reportPage) {
    page = reportPage
    page.setDefaultTimeout(20_000)
  }
  await page.waitForLoadState('domcontentloaded').catch(() => undefined)
}

async function downloadNewestReport() {
  stage = '等待报表生成'
  const datePattern = new RegExp(`${targetDate} 00:00[\\s\\S]{0,160}${targetDate} 23:59`)
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await page.waitForTimeout(attempt ? 5000 : 1500)
    const body = await page.locator('body').innerText()
    if (datePattern.test(body)) {
      const button = await firstVisible(page.getByText('下载报表', { exact: true }))
      if (button) {
        stage = '下载报表'
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 30_000 }),
          button.click(),
        ])
        const folder = path.join(downloadsPath, account.id, targetDate)
        await fs.mkdir(folder, { recursive: true })
        const filename = download.suggestedFilename() || `${account.id}_${targetDate}_orders.csv`
        const destination = path.join(folder, safeName(filename))
        await download.saveAs(destination)
        return destination
      }
    }
    await page.reload({ waitUntil: 'domcontentloaded' })
  }
  throw new Error('等待两分钟后仍未找到昨日生成的可下载报表')
}

try {
  await waitForLogin(page)
  const promotion = await scrapeYesterdayPromotion()
  await openOrders()
  await generateReport()
  const reportPath = await downloadNewestReport()

  const summaryPath = path.join(path.dirname(reportPath), 'download-summary.json')
  await fs.writeFile(summaryPath, JSON.stringify({
    accountId: account.id,
    shopName: account.name,
    date: targetDate,
    yesterdayPromotion: promotion,
    orderReport: reportPath,
    downloadedAt: new Date().toISOString(),
  }, null, 2))

  console.log(`店铺：${account.name}`)
  console.log(`日期：${targetDate}`)
  console.log(`昨日推广费：${promotion.toFixed(2)}`)
  console.log(`订单报表：${reportPath}`)
  console.log('单账号下载流程已完成。')
} catch (error) {
  const screenshot = await saveFailure(page, account, stage)
  console.error(`失败步骤：${stage}`)
  console.error(error instanceof Error ? error.message : error)
  console.error(`失败截图：${screenshot}`)
  process.exitCode = 1
} finally {
  await closeBrowser()
}
