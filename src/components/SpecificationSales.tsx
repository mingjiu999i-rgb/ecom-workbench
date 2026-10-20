import { useMemo } from 'react'
import type { WorkbenchData } from '../types/models'
import { specSalesBasis, summarizeSpecSales, type SpecSalesFilter } from '../utils/specSales'

export function SpecificationSales({ data, ...filter }: { data: WorkbenchData } & SpecSalesFilter) {
  const { clientId, startDate, endDate } = filter
  const report = useMemo(() => summarizeSpecSales(data, { clientId, startDate, endDate }), [data, clientId, startDate, endDate])
  if (!clientId) return null
  return <section className="panel">
    <div className="table-caption"><div><strong>各店铺规格销量</strong><span>跟随上方甲方、日期筛选，导出后位于第一个工作表“总览”下方。{specSalesBasis}</span></div></div>
    {!report.complete && <div className="pdd-message warning">规格资料不完整，以下不是完整销量；缺失数据不按 0 处理。</div>}
    {report.warnings.length > 0 && <div className="pdd-message warning">{report.warnings.map(message => <div key={message}>{message}</div>)}</div>}
    <div className="table-scroll"><table><thead><tr><th>店铺</th><th>规格维度编码</th><th>售卖规格</th><th>总数量（件）</th></tr></thead><tbody>
      {report.rows.map(row => <tr key={row.key}><td>{data.stores.find(store => store.id === row.storeId)?.name || row.storeId}</td><td>{row.skuCode}</td><td>{row.specification}{row.conflictingSpecification && <small>（同编码规格待核对）</small>}</td><td>{row.quantity === null ? '待补数据' : row.quantity.toLocaleString('zh-CN')}</td></tr>)}
      {!report.rows.length && <tr><td colSpan={4}>{report.complete ? '所选范围暂无可统计的规格销量' : '请补导包含规格维度编码、商品规格、商品数量的原订单报表'}</td></tr>}
    </tbody></table></div>
  </section>
}
