import { useEffect } from 'react'
import { useWorkbench } from '../store/workbench'
import type { Order } from '../utils/pddCalculations'
import type { preparePddAccounting } from '../utils/pddLedger'
import { appendProfitBaselines, captureProfitBaselines } from '../utils/profitBaselines'

export function useProfitBaselines(ready: boolean, storeId: string, orders: Map<string, Order>, reportTypes: Set<string>, accounting: ReturnType<typeof preparePddAccounting>) {
  const { data, update, complete } = useWorkbench()
  useEffect(() => {
    if (!ready || !complete || !storeId) return
    const input = { storeId, orderDates: new Set([...orders.values()].map(row => row.payDate)), reportTypes, accounting, recordedAt: new Date().toISOString() }
    if (!captureProfitBaselines(data, input).length) return
    // Recheck inside the recipe: repeated effects/imports cannot overwrite the first value.
    update(current => appendProfitBaselines(current, captureProfitBaselines(current, input)))
  }, [ready, complete, storeId, orders, reportTypes, accounting, data, update])
}
