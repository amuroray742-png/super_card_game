<script setup lang="ts">
/**
 * 召唤：卡池切换、概率公示、保底进度、抽卡与历史。
 * 概率数据一律取 store.rates（core 的 computeEffectiveRates），与抽卡执行同源。
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useGameStore } from '../stores/game'
import { POOLS, resolvePoolHeroIds } from '../../core/config/pools.ts'
import { GACHA } from '../../core/config/economy.ts'
import { HERO_INDEX } from '../../core/config/heroes/index.ts'
import { formatNumber, formatRate } from '../utils/format'
import type { Rarity } from '../../core/model/types.ts'

const store = useGameStore()
const route = useRoute()
const router = useRouter()

const poolId = computed(() => {
  const fromRoute = String(route.params.poolId ?? '')
  const found = POOLS.find((p) => p.id === fromRoute)
  return found ? found.id : POOLS[0].id
})

/**
 * 可见卡池：新手池「初临之赐」仅在**新手保底资格未使用**时显示。
 *
 * 新手保底 = 玩家首次十连必得 1 位传说英灵（§7.3 第 3 条），
 * 消耗后该池与提示一并隐藏，避免出现「写着仅首次可见却一直能进」的矛盾。
 */
const newbieAvailable = computed(() => !store.save.gacha.newbieUsed)
const visiblePools = computed(() => POOLS.filter((p) => !p.newbieOnly || newbieAvailable.value))

// 概率公示按当前池计算（纪元池只收录 SSR/SR，概率与常驻池不同）
watch(
  poolId,
  (id) => {
    store.currentPoolId = id
  },
  { immediate: true },
)

// 新手保底资格消耗后，若正停留在新手池则切回常驻池
watch(newbieAvailable, (available) => {
  const current = POOLS.find((p) => p.id === poolId.value)
  if (!available && current?.newbieOnly) {
    router.replace('/gacha/standard')
  }
})

const pool = computed(() => POOLS.find((p) => p.id === poolId.value) ?? POOLS[0])

/** 该池可抽取的英灵 */
const poolHeroes = computed(() => {
  const ids = resolvePoolHeroIds(pool.value)
  return ids.map((id) => HERO_INDEX.get(id)).filter((h) => !!h)
})

function switchPool(id: string) {
  router.push(`/gacha/${id}`)
}

/** 概率公示 */
const rates = computed(() => store.rates)

/** 本池是否收录全部四档稀有度 */
const allInPool = computed(() => rates.value.rows.every((r) => r.inPool))

/** 池外稀有度并入的档位（取池内存在的最低稀有度） */
const mergedInto = computed(() => {
  const inPool = rates.value.rows.filter((r) => r.inPool).map((r) => r.rarity)
  const order = ['N', 'R', 'SR', 'SSR']
  return order.find((r) => inPool.includes(r as never)) ?? 'SR'
})

/** 单抽当前概率（按保底进度推导） */
const singleRates = computed(() => rates.value.rows.map((r) => `${r.rarity} ${formatRate(r.singleEffective / 100)}`))

/** 抽卡结果弹窗 */
const resultOpen = ref(false)
const result = ref<{ emblems: number; shards: number; silver: number; newHeroes: string[] } | null>(null)

/**
 * 单抽的实际扣费口径（core.resolvePayment 的表现层镜像）：
 * 优先圣杯结晶，结晶不足时自动改用抽卡券。
 */
const singleCostText = computed(() => {
  const p = store.save.player
  if (p.crystals >= GACHA.COST_SINGLE) return `结晶 ${GACHA.COST_SINGLE}`
  if (p.tickets >= GACHA.TICKET_PER_PULL) return `券 ${GACHA.TICKET_PER_PULL}`
  return `结晶 ${GACHA.COST_SINGLE} 或券 ${GACHA.TICKET_PER_PULL}`
})

const canSingle = computed(
  () =>
    store.save.player.crystals >= GACHA.COST_SINGLE ||
    store.save.player.tickets >= GACHA.TICKET_PER_PULL,
)
const canTen = computed(() => store.save.player.crystals >= GACHA.COST_TEN)

async function pull(count: 1 | 10) {
  const summary = await store.pull(poolId.value, count)
  // 余额不足 / 存档冲突时 store 已给出提示，这里直接中止
  if (!summary) return
  result.value = summary
  resultOpen.value = true
  if (summary?.guaranteedTriggered) {
    store.notify('新手保底已触发 · 十连内获得 1 位传说英灵', 'ok')
  }
}

/** 抽卡历史（末 10 条） */
const history = computed(() => [...store.save.gacha.history].slice(-10).reverse())

function heroName(id: string | undefined): string {
  if (!id) return '未记录'
  return HERO_INDEX.get(id)?.name ?? id
}

/** 重复转化收益 */
const DUPLICATE_ROWS: { rarity: Rarity; note: string }[] = [
  { rarity: 'SSR', note: `印记 ${GACHA.DUPLICATE_EMBLEM.SSR} · 同名碎片 ${GACHA.DUPLICATE_SSR_SHARDS}` },
  { rarity: 'SR', note: `印记 ${GACHA.DUPLICATE_EMBLEM.SR}` },
  { rarity: 'R', note: `印记 ${GACHA.DUPLICATE_EMBLEM.R}` },
  { rarity: 'N', note: `印记 ${GACHA.DUPLICATE_EMBLEM.N} · 银两 ${GACHA.DUPLICATE_N_SILVER}` },
]
</script>

<template>
  <div class="page">
    <div class="page-title">召唤</div>

    <!-- 卡池 -->
    <section class="panel">
      <div class="pool-tabs">
        <button
          v-for="p in visiblePools"
          :key="p.id"
          class="chip"
          :class="{ on: p.id === poolId }"
          @click="switchPool(p.id)"
        >
          {{ p.name }}
        </button>
      </div>
      <div class="tiny muted" style="margin-top: 6px">{{ pool.desc }}</div>
      <div class="tiny muted" style="margin-top: 4px">
        本池收录 {{ poolHeroes.length }} 名英灵
      </div>
      <div class="hero-pool">
        <span v-for="h in poolHeroes" :key="h?.id" class="tag" :class="`tag-${h?.rarity.toLowerCase()}`">
          {{ h?.name }}
        </span>
      </div>
    </section>

    <!-- 概率公示 -->
    <section class="panel">
      <div class="panel-title">
        <span>概率公示</span>
        <span class="tiny muted">精确动态规划计算</span>
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
          <tr v-for="row in rates.rows" :key="row.rarity" :class="{ out: !row.inPool }">
            <td><span class="tag" :class="`tag-${row.rarity.toLowerCase()}`">{{ row.rarity }}</span></td>
            <td>{{ formatRate(row.baseRate / 100) }}</td>
            <td>{{ formatRate(row.tenPullEffective / 100) }}</td>
          </tr>
        </tbody>
      </table>
      <p class="tiny muted" style="margin: 8px 0 0; line-height: 1.7">
        综合概率指一次十连内至少出现 1 次该稀有度或更高的概率，由
        <b>精确动态规划</b>计算（与实际抽卡同源，无模拟误差）。
      </p>
      <p class="tiny muted" style="margin: 4px 0 0; line-height: 1.7">
        十连保底规则保证十连内至少 1 个 SR 及以上，故对应行显示
        {{ formatRate(100 / 100) }} 个百分点；有区分度的是 SSR 行与下方「当前保底进度下单抽概率」。
      </p>
      <p v-if="!allInPool" class="tiny muted" style="margin: 4px 0 0; line-height: 1.7">
        本池未收录的稀有度，其概率已并入池内最低稀有度（{{ mergedInto }}），故对应行显示 0.00%。
      </p>
      <div class="tiny muted" style="margin-top: 6px">
        当前保底进度下单抽概率：{{ singleRates.join(' · ') }}
      </div>
    </section>

    <!-- 保底 -->
    <section class="panel">
      <div class="panel-title"><span>保底规则</span></div>
      <div class="row-between tiny">
        <span class="muted">大保底上限</span>
        <b>{{ rates.pityMax }} 抽</b>
      </div>
      <div class="row-between tiny">
        <span class="muted">距必出还差</span>
        <b>{{ rates.pityRemaining }} 抽</b>
      </div>
      <div class="bar" style="margin: 6px 0 8px">
        <i :style="{ width: `${Math.min(100, (rates.pityRemaining / rates.pityMax) * 100)}%` }"></i>
      </div>
      <div class="row-between tiny">
        <span class="muted">软保底起点</span>
        <b>第 {{ rates.softPityStart }} 抽</b>
      </div>
      <div class="row-between tiny">
        <span class="muted">十连保底</span>
        <b>至少 {{ GACHA.TEN_PULL_FLOOR }}</b>
      </div>
      <div class="row-between tiny">
        <span class="muted">当前计数</span>
        <b>SSR {{ store.save.gacha.pitySSR }} · SR+ {{ store.save.gacha.pity10 }}</b>
      </div>
      <p class="tiny muted" style="margin: 8px 0 0">保底计数在各卡池之间共享继承。</p>
    </section>

    <!-- 抽卡 -->
    <section class="panel">
      <div class="panel-title"><span>召唤</span></div>
      <div class="row" style="gap: 6px">
        <button class="btn btn-sm" style="flex: 1" :disabled="!canSingle" @click="pull(1)">
          单抽<br />
          <span class="tiny">{{ singleCostText }}</span>
        </button>
        <button class="btn btn-sm btn-primary" style="flex: 1" :disabled="!canTen" @click="pull(10)">
          十连<br />
          <span class="tiny">结晶 {{ GACHA.COST_TEN }}</span>
        </button>
      </div>
      <div class="row-between tiny" style="margin-top: 8px">
        <span class="muted">圣杯结晶</span>
        <b>{{ formatNumber(store.save.player.crystals) }}</b>
      </div>
      <div class="row-between tiny">
        <span class="muted">抽卡券</span>
        <b>{{ formatNumber(store.save.player.tickets) }}</b>
      </div>
    </section>

    <!-- 重复转化 -->
    <section class="panel">
      <div class="panel-title"><span>重复获取转化</span></div>
      <p class="tiny muted" style="margin: 0 0 8px">
        重复获得的英灵不会直接提升强度，统一转化为通用英灵印记与同名碎片。
      </p>
      <div v-for="row in DUPLICATE_ROWS" :key="row.rarity" class="row-between tiny dup-row">
        <span class="tag" :class="`tag-${row.rarity.toLowerCase()}`">{{ row.rarity }}</span>
        <span class="muted">{{ row.note }}</span>
      </div>
    </section>

    <!-- 历史 -->
    <section class="panel">
      <div class="panel-title">
        <span>召唤历史</span>
        <span class="tiny muted">末 {{ history.length }} 条</span>
      </div>
      <div v-if="history.length === 0" class="empty" style="padding: 16px">尚无召唤记录</div>
      <div v-for="(h, i) in history" :key="i" class="row-between tiny hist-row">
        <div class="row" style="gap: 6px">
          <span class="tag" :class="`tag-${h.rarity.toLowerCase()}`">{{ h.rarity }}</span>
          <span>{{ heroName(h.heroId) }}</span>
        </div>
        <span class="tiny muted">{{ h.isNew ? '新获得' : '重复转化' }}</span>
      </div>
    </section>

    <!-- 抽卡结果 -->
    <div v-if="resultOpen && result" class="mask" @click.self="resultOpen = false">
      <div class="dialog">
        <div class="panel-title">召唤结果</div>
        <div v-if="result.newHeroes.length" class="new-heroes">
          <div class="tiny muted" style="margin-bottom: 6px">新获得英灵</div>
          <div class="new-hero-grid">
            <div v-for="(id, i) in result.newHeroes" :key="i" class="new-hero">
              <img
                :src="HERO_INDEX.get(id)?.portrait"
                class="portrait"
                :class="`portrait-${HERO_INDEX.get(id)?.rarity.toLowerCase()}`"
                width="84"
                height="112"
              />
              <span>{{ heroName(id) }}</span>
            </div>
          </div>
        </div>
        <div v-else class="tiny muted" style="margin-bottom: 8px">本次没有新获得英灵。</div>
        <div class="row-between tiny">
          <span class="muted">英灵印记</span>
          <b>+{{ formatNumber(result.emblems) }}</b>
        </div>
        <div class="row-between tiny">
          <span class="muted">同名碎片</span>
          <b>+{{ formatNumber(result.shards) }}</b>
        </div>
        <div class="row-between tiny">
          <span class="muted">银两</span>
          <b>+{{ formatNumber(result.silver) }}</b>
        </div>
        <button class="btn btn-primary btn-block" style="margin-top: 12px" @click="resultOpen = false">收下</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pool-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  padding: 6px 11px;
  border-radius: 999px;
  border: 1px solid var(--c-line);
  background: var(--c-bg-2);
  font-size: 12px;
  color: var(--c-text-dim);
  min-height: 32px;
}

.chip.on {
  border-color: var(--c-gold);
  color: var(--c-gold-2);
  background: #2a2419;
}

.hero-pool {
  margin-top: 8px;
  max-height: 108px;
  overflow-y: auto;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
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

.dup-row,
.hist-row {
  padding: 4px 0;
}

.new-heroes {
  margin-bottom: 10px;
}

/* 新获得英灵：3:4 完整卡面（与生成的卡面同比例，不裁切） */
.new-hero-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 10px;
}

.new-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 84px;
  color: var(--c-gold-2);
  font-size: 12px;
  text-align: center;
}
</style>
