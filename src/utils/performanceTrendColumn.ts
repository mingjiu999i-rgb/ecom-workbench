import { roundMoney } from './performanceSummary'

// Chart-only subtraction. Saved profits and refunds remain unchanged.
export function performanceTrendColumn(savedProfit: number | null, savedRefund: number | null) {
  const profit = Number.isFinite(savedProfit) ? savedProfit : null
  const refund = Number.isFinite(savedRefund) ? savedRefund : null
  const balance = profit != null && refund != null ? roundMoney(profit - refund) : null
  const resultRange = balance == null ? null : { low: Math.min(0, balance), high: Math.max(0, balance) }
  const refundRange = refund == null ? null : profit != null && balance != null
    ? { low: Math.min(profit, balance), high: Math.max(profit, balance) }
    : { low: Math.min(0, refund), high: Math.max(0, refund) }
  const overlap = resultRange != null && refundRange != null && Math.min(resultRange.high, refundRange.high) > Math.max(resultRange.low, refundRange.low)
  return { profit, refund, balance, resultRange, refundRange, overlap,
    low: Math.min(0, profit ?? 0, balance ?? 0, refundRange?.low ?? 0),
    high: Math.max(0, profit ?? 0, balance ?? 0, refundRange?.high ?? 0) }
}
