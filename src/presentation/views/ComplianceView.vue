<script setup lang="ts">
/**
 * 合规与概率公示。
 *
 * ## 分工
 *
 * - **文案**（条款文字）：全部来自 `src/content/compliance/index.ts`，界面不拼装；
 * - **数据**（概率 / 保底 / 印记折算）：来自 core 的实时值，界面按 `{key}` 占位符填充；
 * - **表格**（逐卡池概率）：数据来自 core 的 `computeEffectiveRates`，与实际抽卡同源。
 *
 * 界面不做任何加减法，也不自己写条款 —— 改文案只改 content 模块。
 */
import { computed } from 'vue'
import { useGameStore } from '../stores/game'
import { GACHA } from '../../core/config/economy.ts'
import { POOLS } from '../../core/config/pools.ts'
import { formatRate } from '../utils/format'
import {
  COMPLIANCE_SECTIONS,
  CONTACT,
  RATES_PUBLICATION,
  chineseOrdinal,
  fillTemplate,
  richParts,
} from '../../content/compliance/index.ts'

const store = useGameStore()

/** 逐卡池的概率公示（不同卡池收录范围不同，概率也不同，必须分别公示） */
const poolRates = computed(() =>
  POOLS.map((pool) => ({
    pool,
    rates: store.ratesForPool(pool.id),
  })),
)

/**
 * 占位符取值表。
 * 全部来自 core 配置与实时保底状态，界面不自己算。
 */
const vars = computed(() => ({
  pityMax: store.rates.pityMax,
  softPityStart: store.rates.softPityStart,
  pityRemaining: store.rates.pityRemaining,
  tenPullFloor: GACHA.TEN_PULL_FLOOR,
  // ⚠ **实施修正（资源/背包版本 v10）**：重复卡**只给同名碎片**，全稀有度适用
  //   （设计稿 §2）。英灵印记与「N 卡重复给银两」两条旧路径已退役。
  dupSsr: GACHA.DUPLICATE_SHARDS.SSR,
  dupSr: GACHA.DUPLICATE_SHARDS.SR,
  dupR: GACHA.DUPLICATE_SHARDS.R,
  dupN: GACHA.DUPLICATE_SHARDS.N,
  contactEmail: CONTACT.email || CONTACT.missing,
  replyTime: CONTACT.replyTime,
}))

/** 第一节是概率表本体（表格在界面里渲染），其余章节按配置顺序渲染 */
const tableSection = COMPLIANCE_SECTIONS[0]
const bodySections = COMPLIANCE_SECTIONS.slice(1)

/** 渲染一节的文案（填充占位符） */
function itemsOf(index: number): string[] {
  const section = index === 0 ? tableSection : bodySections[index - 1]
  return section.items.map((item) => fillTemplate(item, vars.value))
}

/** 拆成粗体片段供模板渲染（不用 v-html） */
function partsOf(text: string): { text: string; bold: boolean }[] {
  return richParts(text)
}
</script>

<template>
  <div class="page">
    <div class="page-title">合规与概率公示</div>

    <!-- 一、召唤概率公示（表格数据来自 core，与实际抽卡同源） -->
    <section class="panel">
      <div class="panel-title">
        <span>{{ chineseOrdinal(1) }}、{{ tableSection.title }}</span>
        <span class="tiny muted">精确动态规划计算</span>
      </div>
      <div v-for="entry in poolRates" :key="entry.pool.id" class="pool-rate">
        <div class="pool-rate-title">
          {{ entry.pool.name }}
          <span class="tiny muted">{{ entry.pool.heroIds.length || entry.rates.rows.filter((r) => r.inPool).length }} 项收录</span>
        </div>
        <table class="rate-table">
          <thead>
            <tr>
              <th>稀有度</th>
              <th>基础概率</th>
              <th>综合概率</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in entry.rates.rows" :key="row.rarity" :class="{ out: !row.inPool }">
              <td>
                <span class="tag" :class="`tag-${row.rarity.toLowerCase()}`">{{ row.rarity }}</span>
                <span v-if="!row.inPool" class="tiny muted">（本池未收录）</span>
              </td>
              <td>{{ formatRate(row.baseRate / 100) }}</td>
              <td>{{ formatRate(row.tenPullEffective / 100) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <ul class="notes">
        <li v-for="item in itemsOf(0)" :key="item">
          <template v-for="(part, pi) in partsOf(item)">
            <b v-if="part.bold" :key="`b${pi}`">{{ part.text }}</b>
            <template v-else>{{ part.text }}</template>
          </template>
        </li>
        <li v-if="!store.loaded">当前显示常规十连的概率。登录后按账号的保底进度及首次十连资格显示。</li>
      </ul>
    </section>

    <!-- 二 ~ 十二：其余章节，文案全部来自 content 模块 -->
    <section v-for="(section, index) in bodySections" :key="section.id" class="panel">
      <div class="panel-title"><span>{{ chineseOrdinal(index + 2) }}、{{ section.title }}</span></div>
      <ul class="notes">
        <li v-for="item in itemsOf(index + 1)" :key="item">
          <template v-for="(part, pi) in partsOf(item)">
            <b v-if="part.bold" :key="`b${pi}`">{{ part.text }}</b>
            <template v-else>{{ part.text }}</template>
          </template>
        </li>
      </ul>
    </section>

    <p class="tiny muted footer-note">
      概率公示版本 {{ RATES_PUBLICATION.version }}（自 {{ RATES_PUBLICATION.effectiveFrom }} 起生效）·
      客服邮箱 {{ CONTACT.email || CONTACT.missing }} ·
      本页数据来源：{{ store.rates.computation === 'exact-dp' ? '精确动态规划' : '—' }}
    </p>
  </div>
</template>

<style scoped>
.pool-rate {
  margin-bottom: 14px;
}

.pool-rate-title {
  font-size: 12px;
  color: var(--c-gold);
  margin-bottom: 4px;
  display: flex;
  justify-content: space-between;
}

.rate-table tr.out td {
  color: var(--c-text-mute);
  opacity: 0.65;
}

.rate-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.rate-table th {
  font-size: 11px;
  font-weight: 500;
  color: var(--c-text-mute);
  text-align: right;
  padding: 4px 0;
  border-bottom: 1px solid var(--c-line);
}

.rate-table th:first-child,
.rate-table td:first-child {
  text-align: left;
}

.rate-table td {
  text-align: right;
  padding: 5px 0;
  border-bottom: 1px solid var(--c-line);
}

.rate-table tr:last-child td {
  border-bottom: none;
}

.notes {
  margin: 8px 0 0;
  padding-left: 18px;
}

.notes li {
  font-size: 12px;
  line-height: 1.9;
  color: var(--c-text-dim);
  margin-bottom: 2px;
}

.footer-note {
  text-align: center;
  margin: 12px 0 0;
}
</style>
