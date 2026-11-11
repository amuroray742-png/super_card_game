/** 展示层格式化工具（纯函数，不含规则判断）。 */

/** 大数格式化：万 / 亿 */
export function formatNumber(n: number): string {
  const v = Math.floor(n)
  if (v >= 1e8) return `${(v / 1e8).toFixed(2)}亿`
  if (v >= 1e4) return `${(v / 1e4).toFixed(1)}万`
  return v.toLocaleString('en-US')
}

/** 百分比，保留两位小数（概率公示强制口径） */
export function formatRate(v: number): string {
  return `${(v * 100).toFixed(2)}%`
}

/** 战力简写 */
export function formatPower(n: number): string {
  return formatNumber(n)
}

/** 百分比（整数，用于 UI 进度） */
export function percent(part: number, total: number): number {
  if (total <= 0) return 0
  return Math.max(0, Math.min(100, (part / total) * 100))
}

/** 秒 → 时分 */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h} 小时 ${m} 分`
  if (m > 0) return `${m} 分钟`
  return `${s} 秒`
}
