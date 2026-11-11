/** 一次性取数：十连综合概率（精确 DP），用于回写方案文件。 */
import { computeTenPullOutcomes, computeEffectiveRates } from '../../src/core/systems/gachaRates.ts'

const outcomes = computeTenPullOutcomes({ pitySSR: 0, pity10: 0 })
console.log('十连内「至少出现 1 次该稀有度或更高」（精确 DP，pity=0）:')
console.log(`  SSR   ${(outcomes.ssr * 100).toFixed(2)}%`)
console.log(`  SR+   ${(outcomes.srPlus * 100).toFixed(2)}%`)
console.log(`  R+    ${(outcomes.rPlus * 100).toFixed(2)}%`)
console.log(`  N     ${(outcomes.n * 100).toFixed(2)}%`)
console.log('\n注：十连保底规则保证至少 1 个 SR 及以上，故 SR+ / R+ / N 行恒为 100.00 个百分点；')
console.log('    实际有区分度的是 SSR 行（十连内至少 1 个 SSR 的概率）与「当前保底进度下单抽概率」。')

const snap = computeEffectiveRates({ pitySSR: 0, pity10: 0 })
console.log('\n公示表行：')
for (const r of snap.rows) {
  console.log(`  ${r.rarity.padEnd(4)} 基础 ${r.baseRate.toFixed(2)}%  单抽 ${r.singleEffective.toFixed(2)}%  十连 ${r.tenPullEffective.toFixed(2)}%`)
}
console.log(`\ncomputation = ${snap.computation}`)
console.log(`pityRemaining = ${snap.pityRemaining} / ${snap.pityMax}，软保底起点 ${snap.softPityStart}`)
