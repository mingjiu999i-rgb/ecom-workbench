import type { CollectionRecord } from '../types/models'
import { roundMoney, shiftDate, validDate } from './performanceSummary'

export type RefundReviewPeriod = {
  start: string; end: string; observedDays: number; expectedDays: number
  orderCount: number | null; originalSales: number | null; shippedRefund: number | null
  refundRate: number | null; settledOrders: number | null; eligibleOrders: number | null
  paymentCompletion: number | null; currentNet: number | null; effectiveSales: number | null
  netReceiptRatio: number | null; unsettledAmount: number | null
  latestProfit: number | null; currentProfit: number | null
  missingRefundBasis: boolean; completeCoverage: boolean
}

export type RefundReviewFinding = {
  current: RefundReviewPeriod; baseline: RefundReviewPeriod
  rateChange: number; rateMultiple: number | null
  paymentChange: number | null; netReceiptChange: number | null
  severity: 'high' | 'elevated'
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const daysBetween = (start: string, end: string) => Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1
const amount = (rows: CollectionRecord[], read: (row: CollectionRecord) => unknown) => rows.every(row => finite(read(row)))
  ? roundMoney(rows.reduce((total, row) => total + Number(read(row)), 0)) : null

export function summarizeRefundPeriod(rows: CollectionRecord[], start: string, end: string): RefundReviewPeriod {
  const selected = rows.filter(row => validDate(row.date) && row.date >= start && row.date <= end)
  const observedDays = new Set(selected.map(row => row.date)).size
  const expectedDays = validDate(start) && validDate(end) && start <= end ? daysBetween(start, end) : 0
  const originalSales = selected.length ? amount(selected, row => row.originalSales) : null
  const refunded = selected.length ? amount(selected, row => row.orderShippedRefund ?? (row.refundBasis === 'order_paid_at' ? row.shippedRefund : null)) : null
  const settledOrders = selected.length ? amount(selected, row => row.settledOrders) : null
  const eligibleOrders = selected.length ? amount(selected, row => row.eligibleOrders) : null
  const currentNet = selected.length ? amount(selected, row => row.currentNet) : null
  const effectiveSales = selected.length ? amount(selected, row => row.effectiveSales) : null
  return {
    start, end, observedDays, expectedDays,
    orderCount: selected.length ? amount(selected, row => row.orderCount) : null,
    originalSales, shippedRefund: refunded,
    refundRate: refunded != null && originalSales != null && originalSales > 0 ? refunded / originalSales : null,
    settledOrders, eligibleOrders,
    paymentCompletion: settledOrders != null && eligibleOrders != null && eligibleOrders > 0 ? settledOrders / eligibleOrders : null,
    currentNet, effectiveSales,
    netReceiptRatio: currentNet != null && effectiveSales != null && effectiveSales > 0 ? currentNet / effectiveSales : null,
    unsettledAmount: selected.length ? amount(selected, row => row.unsettledAmount) : null,
    latestProfit: selected.length ? amount(selected, row => row.estimatedProfit) : null,
    currentProfit: selected.length ? amount(selected, row => row.profit) : null,
    missingRefundBasis: selected.some(row => row.orderShippedRefund == null && row.refundBasis !== 'order_paid_at'),
    completeCoverage: expectedDays > 0 && observedDays === expectedDays,
  }
}

const monday = (date: string) => shiftDate(date, -(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7)

export function findRefundAnomalies(rows: CollectionRecord[], start: string, end: string): RefundReviewFinding[] {
  if (!validDate(start) || !validDate(end) || start > end) return []
  const findings: RefundReviewFinding[] = []
  for (let week = monday(start); week <= end; week = shiftDate(week, 7)) {
    const weekEnd = shiftDate(week, 6)
    if (week < start || weekEnd > end) continue
    const current = summarizeRefundPeriod(rows, week, weekEnd)
    const baseline = summarizeRefundPeriod(rows, shiftDate(week, -28), shiftDate(week, -1))
    // Dates absent from saved settlement records are unknown. Compare only full windows.
    if (!current.completeCoverage || !baseline.completeCoverage || current.refundRate == null || baseline.refundRate == null) continue
    if (current.originalSales == null || baseline.originalSales == null || current.originalSales <= 0 || baseline.originalSales <= 0) continue
    const rateChange = current.refundRate - baseline.refundRate
    const rateMultiple = baseline.refundRate > 0 ? current.refundRate / baseline.refundRate : null
    // A material rate increase must exceed both 2 percentage points and 50% relative growth.
    // A zero historical rate has no meaningful relative multiple; the absolute guard applies.
    if (rateChange < 0.02 || (rateMultiple != null && rateMultiple < 1.5)) continue
    const paymentChange = current.paymentCompletion != null && baseline.paymentCompletion != null
      ? current.paymentCompletion - baseline.paymentCompletion : null
    const netReceiptChange = current.netReceiptRatio != null && baseline.netReceiptRatio != null
      ? current.netReceiptRatio - baseline.netReceiptRatio : null
    findings.push({ current, baseline, rateChange, rateMultiple, paymentChange, netReceiptChange,
      severity: (paymentChange != null && paymentChange <= -0.05) || (netReceiptChange != null && netReceiptChange <= -0.05) ? 'high' : 'elevated' })
  }
  return findings.sort((a, b) => (b.severity === 'high' ? 1 : 0) - (a.severity === 'high' ? 1 : 0) || b.rateChange - a.rateChange || b.current.start.localeCompare(a.current.start))
}
