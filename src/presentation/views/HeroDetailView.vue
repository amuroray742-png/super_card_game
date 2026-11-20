<script setup lang="ts">
/**
 * 英灵详情：属性 / 技能 / 被动 / 传记 / 羁绊 / 遗物槽。
 * 规则一律取自 core，组件只做展示与调用 store 的 action。
 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useGameStore } from '../stores/game'
import { HERO_INDEX } from '../../core/config/heroes/index.ts'
import { BONDS } from '../../core/config/bonds.ts'
import { SKILL, LEVEL, EXP_BOOK } from '../../core/config/economy.ts'
import {
  EXP_BOOK_ITEM_EXP,
  ITEM_BY_ELEMENT,
  ITEM_DEFS,
  ITEM_LIST,
  type ItemId,
} from '../../core/config/items.ts'
import {
  expToNext,
  starUpCost,
  applyExp,
  previewFeed,
  getHeroPassiveMods,
  skillLevelCap,
  skillUpCost,
  realmBreakCost,
  atRealmGate,
} from '../../core/systems/growth.ts'
import { findDungeonVariant, dungeonDropAmount } from '../../core/config/dungeons.ts'
import { RELIC_DEFS, RELIC_SETS, getHeroSetMods, relicUpgradeCost } from '../../core/systems/relic.ts'
import type { RelicAdvice } from '../../core/systems/relic-advice.ts'
import { relicIconPath, resourceIconPath } from '../../core/config/art.ts'
import { resolveStats, computePower, getRealm, nextRealm } from '../../core/systems/stats.ts'
import { RELIC_SLOT_COUNT } from '../../core/systems/loadout.ts'
import { formatNumber } from '../utils/format'
import type { RelicInstance, HeroRuntime, FinalStats } from '../../core/model/types.ts'

const store = useGameStore()
const route = useRoute()
const router = useRouter()

const heroId = computed(() => String(route.params.id ?? ''))
const def = computed(() => HERO_INDEX.get(heroId.value) ?? null)
const state = computed(() => store.save.heroes[heroId.value] ?? null)
const owned = computed(() => !!state.value)

/**
 * 可用的经验书（背包里有的那些）。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：玩家经验池退役 →
 *   喂经验改为「选经验书 + 选数量 + 预览 + 使用」（设计稿 §2）。
 */
const bookList = computed(() => ITEM_LIST.filter((b) => b.category === 'expBook'))

/** 选中的经验书 */
const selectedBook = ref<ItemId>(EXP_BOOK.small.id)

/** 选中的书当前持有量 */
const bookOwned = computed(() => store.save.items[selectedBook.value] ?? 0)

/** 想喂的本数 */
const feedCount = ref(1)

/**
 * 喂书预览（**纯计算**，不改存档）。
 *
 * ⚠ 预览走 core 的 `previewFeed()`——表现层不得自己算「能升几级」
 *   （铁律 #4：口径只有一份）。
 */
const feedPreview = computed(() => {
  const s = state.value
  if (!s) return null
  const exp = EXP_BOOK_ITEM_EXP[selectedBook.value] ?? 0
  return previewFeed(s, exp, feedCount.value)
})

/** 当前境界 */
const realmLabel = computed(() => {
  const s = state.value
  if (!s) return ''
  const r = getRealm(s.level)
  return `${r.name}（Lv${r.minLevel}-${r.maxLevel}）`
})

/**
 * 境界门槛信息。卡在门槛（凡阶末 Lv60 / 名阶末 Lv120 / 圣阶末 Lv180）时才非空。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：突破改扣**银两**（印记已退役）。
 */
const realmGate = computed(() => {
  const s = state.value
  if (!s) return null
  if (!atRealmGate(s.level)) return null
  const cost = realmBreakCost(s.level)
  if (!cost) return null
  const next = nextRealm(s.level)
  const silver = store.save.player.silver
  return { cost, nextName: next?.name ?? '', silver, ok: silver >= cost.silver }
})

/** 喂书的可用性与提示 */
function feedHint(): { ok: boolean; text: string } {
  const s = state.value
  if (!s) return { ok: false, text: '' }
  if (s.level >= LEVEL.MAX) return { ok: false, text: '已达最高等级' }
  if (bookOwned.value < feedCount.value) {
    return {
      ok: false,
      text: `${ITEM_DEFS[selectedBook.value].name}不足（${formatNumber(bookOwned.value)} / ${formatNumber(feedCount.value)}）`,
    }
  }
  return { ok: true, text: '' }
}

/** 升级后的下一级所需经验（用于经验条） */
const expNeed = computed(() => (state.value ? expToNext(state.value.level) : 0))
const expPct = computed(() => {
  if (!state.value || expNeed.value <= 0) return 0
  return Math.min(100, (state.value.exp / expNeed.value) * 100)
})

/** 升星消耗（**只扣同名碎片**，印记已退役） */
const starCost = computed(() => (state.value ? starUpCost(state.value.star) : null))
const shards = computed(() => store.save.player.shards[heroId.value] ?? 0)

/** 升技能用的五行材料名（取登记表，不就地写中文名） */
const skillMaterialName = computed(() => {
  const element = def.value?.element
  if (!element) return ''
  return ITEM_DEFS[ITEM_BY_ELEMENT[element]].name
})

/** 6 个遗物槽 */
const relicSlots = computed<(RelicInstance | null)[]>(
  () => store.equippedMap.get(heroId.value) ?? new Array(RELIC_SLOT_COUNT).fill(null),
)

/** 与该英灵相关的羁绊（并附当前编队的达成情况） */
const heroBonds = computed(() => {
  const d = def.value
  if (!d) return []
  return BONDS.map((bond) => {
    const team = store.bondStates.find((s) => s.bond.id === bond.id)
    const cond = bond.condition
    let relevant = true
    if (cond.type === 'role') relevant = cond.role === d.role
    else if (cond.type === 'element') relevant = cond.element === d.element
    return {
      bond,
      relevant,
      count: team?.count ?? 0,
      active: team?.active ?? false,
    }
  }).filter((x) => x.relevant)
})

// ─────────────────────────── 属性与提升预览 ───────────────────────────

/**
 * 该英灵的运行时对象。
 *
 * 属性一律经 core 的唯一入口 `resolveStats` 取（AGENTS.md 铁律 #2），
 * 表现层不自己算「基础属性 × 成长」——那会与战斗里的算法分叉。
 */
const runtime = computed<HeroRuntime | null>(() => {
  const d = def.value
  const s = state.value
  if (!d || !s) return null
  return { def: d, state: s, relics: relicSlots.value, slot: 0 }
})

/** 取属性（PVE 路径，含境界 / 遗物 / 星级被动 / 遗物套装；不含羁绊） */
function statsOf(rt: HeroRuntime): FinalStats {
  return resolveStats(
    rt,
    { mode: 'pve', seed: 0 },
    { passives: getHeroPassiveMods(rt), setMods: getHeroSetMods(rt) },
  )
}

/** 当前属性 */
const currentStats = computed(() => (runtime.value ? statsOf(runtime.value) : null))
/** 当前战力 */
const currentPower = computed(() => (currentStats.value ? computePower(currentStats.value) : 0))

/** 四项主属性（展示用） */
const statRows = computed(() => {
  const s = currentStats.value
  if (!s) return []
  return [
    { key: 'atk' as const, label: '攻击', value: s.atk },
    { key: 'def' as const, label: '防御', value: s.def },
    { key: 'hp' as const, label: '生命', value: s.hp },
    { key: 'spd' as const, label: '速度', value: s.spd },
  ]
})

/** 属性差值（预览 - 当前） */
function gainOf(pre: FinalStats, cur: FinalStats) {
  return {
    atk: Math.round(pre.atk - cur.atk),
    def: Math.round(pre.def - cur.def),
    hp: Math.round(pre.hp - cur.hp),
    spd: Math.round(pre.spd - cur.spd),
    power: Math.round(computePower(pre) - computePower(cur)),
  }
}

/**
 * 各档位喂经验后的提升预览。
 *
 * ⚠ **逐档算**，而不是只算最大档——否则玩家点「喂 1.0万」时看到的
 *   是「喂 10.0万」的收益，预览与实际不符。
 *   试算用 `applyExp` 的**同一套语义**在克隆体上做（不碰真实存档），
 *   所以预览显示的等级与实际喂经验的结果必然一致。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：档位从「喂 N 经验」改成
 *   「喂一本经验书」——经验池退役后，玩家能选的单位是**本数**。
 */
const levelPreviews = computed(() => {
  const rt = runtime.value
  const cur = currentStats.value
  if (!rt || !cur) return []
  const out: { feed: number; levels: number; gain: ReturnType<typeof gainOf> }[] = []
  for (const book of bookList.value) {
    const exp = EXP_BOOK_ITEM_EXP[book.id] ?? 0
    if (exp <= 0) continue
    const clone: HeroRuntime = { ...rt, state: { ...rt.state } }
    const res = applyExp(clone.state, exp)
    if (res.levelsGained <= 0) continue
    out.push({ feed: exp, levels: res.levelsGained, gain: gainOf(statsOf(clone), cur) })
  }
  return out
})

/** 升星后的提升预览（升星会解锁新的星级被动） */
const starGain = computed(() => {
  const rt = runtime.value
  const cur = currentStats.value
  if (!rt || !cur || !starCost.value) return null
  const clone: HeroRuntime = { ...rt, state: { ...rt.state, star: rt.state.star + 1 } }
  return { gain: gainOf(statsOf(clone), cur) }
})

// ─────────────────────────── 交互 ───────────────────────────

/** 遗物选择器 */
const pickerOpen = ref(false)
const pickerSlot = ref(0)
/**
 * 选择器里的仓库列表（**服务端分页**）。
 *
 * ⚠ 客户端镜像里只有已装备遗物，仓库里可能几千件 → 选择器也走分页接口，
 *   不把整个仓库拉进内存。
 */
const pickerPage = ref(1)
const pickerSize = 30
const pickerItems = ref<RelicInstance[]>([])
const pickerTotal = ref(0)
const pickerPages = ref(1)
const pickerLoading = ref(false)

async function loadPicker(page = pickerPage.value) {
  pickerLoading.value = true
  const result = await store.queryRelics({ page, size: pickerSize })
  pickerLoading.value = false
  if (!result) return
  pickerPage.value = result.page
  pickerItems.value = result.items
  pickerTotal.value = result.total
  pickerPages.value = result.pages
}

/** 已装备遗物的操作菜单 */
const menuSlot = ref<number | null>(null)

/** 菜单当前对应的遗物 */
const menuRelic = computed(() =>
  menuSlot.value === null ? null : (relicSlots.value[menuSlot.value] ?? null),
)

/** 分解二次确认 */
const confirmRelic = ref<RelicInstance | null>(null)

/**
 * 菜单里那件遗物的强化花费与可用性（银两 / 强化石不够就把差额写出来）。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：强化石分三档，扣的是**目标等级所属档**，
 *   持有量与花费都按档读 `save.items`（不再是单一的 `player.relicStones`）。
 */
const menuUpgrade = computed(() => {
  const r = menuRelic.value
  if (!r) return { cost: null, ok: false, text: '' }
  const cost = relicUpgradeCost(r.level)
  if (!cost) return { cost, ok: false, text: '已达最高强化等级' }
  const p = store.save.player
  if (p.silver < cost.silver) {
    return { cost, ok: false, text: `银两不足（${formatNumber(p.silver)} / ${formatNumber(cost.silver)}）` }
  }
  for (const [id, need] of Object.entries(cost.stones)) {
    const owned = store.save.items[id as ItemId] ?? 0
    if (owned < (need ?? 0)) {
      const name = ITEM_DEFS[id as ItemId]?.name ?? id
      return {
        cost,
        ok: false,
        text: `${name}不足（${formatNumber(owned)} / ${formatNumber(need ?? 0)}）`,
      }
    }
  }
  return { cost, ok: true, text: '' }
})

/** 遗物强化石消耗文案（**按档位**，名称取登记表） */
const menuStoneCostText = computed(() => {
  const stones = menuUpgrade.value.cost?.stones ?? {}
  return Object.entries(stones)
    .map(([id, n]) => `${ITEM_DEFS[id as ItemId]?.name ?? id} ${n}`)
    .join(' · ')
})

function openPicker(slot: number) {  pickerSlot.value = slot
  menuSlot.value = null
  pickerOpen.value = true
  void loadPicker(1)
}

function chooseRelic(uid: string) {
  store.equip(heroId.value, pickerSlot.value, uid)
  pickerOpen.value = false
}

function upgradeRelic(uid: string) {
  store.upgradeRelic(uid)
}

function askDecompose(relic: RelicInstance) {
  menuSlot.value = null
  confirmRelic.value = relic
}

function doDecompose() {
  const relic = confirmRelic.value
  if (!relic) return
  store.decomposeRelic(relic.uid)
  confirmRelic.value = null
}

function unequip(slot: number) {
  store.unequip(heroId.value, slot)
  menuSlot.value = null
}

function relicName(relic: RelicInstance): string {
  return RELIC_DEFS.get(relic.defId)?.name ?? relic.defId
}

// ─────────────────────────── 套装效果 ───────────────────────────

/**
 * 该英灵身上的套装进度。
 *
 * ⚠ 套装效果**早已存在**（`config/relics.ts` 的 2/4/6 档 + `getSetMods`，
 *   战斗与战力计算都已接上），但界面**完全没展示**它——
 *   玩家不知道「再凑 1 件就能开 4 件套」，这条养成线等于隐形。
 *
 * 档位判定一律读 `RELIC_SETS[].bonuses`（不硬编码 2/4/6，配置改了自动跟）。
 */
const setRows = computed(() => {
  const counts = new Map<string, number>()
  for (const r of relicSlots.value) {
    if (!r) continue
    const def = RELIC_DEFS.get(r.defId)
    if (!def) continue
    counts.set(def.setId, (counts.get(def.setId) ?? 0) + 1)
  }

  // 仓库里每个套装共有多少件（含未装备的）——用来提示「还能换」
  // ⚠ 仓库件数由**服务端统计**给出（客户端镜像里只有已装备遗物）
  const owned = new Map<string, number>()
  for (const [defId, count] of Object.entries(store.relicStats.byDefId)) {
    const def = RELIC_DEFS.get(defId)
    if (!def) continue
    owned.set(def.setId, (owned.get(def.setId) ?? 0) + count)
  }

  return [...counts.entries()]
    .map(([setId, count]) => {
      const set = RELIC_SETS.get(setId)
      const tiers = (set?.bonuses ?? []).map((b) => ({
        pieces: b.pieces,
        desc: b.desc,
        active: count >= b.pieces,
        need: Math.max(0, b.pieces - count),
      }))
      const next = tiers.find((t) => !t.active)
      return {
        setId,
        name: set?.name ?? setId,
        desc: set?.desc ?? '',
        count,
        tiers,
        nextPieces: next?.pieces ?? 0,
        nextNeed: next?.need ?? 0,
        // 仓库里该套装还有几件是**没装在这名英灵身上**的
        spare: Math.max(0, (owned.get(setId) ?? 0) - count),
      }
    })
    .sort((a, b) => b.count - a.count)
})

// ─────────────────────────── 一键推荐装备 ───────────────────────────

/**
 * 遗物推荐方案（**服务端计算**）。
 *
 * ⚠ 分包后客户端镜像里只有已装备遗物，本地算不出「仓库里哪件更强」→
 *   预览必须走服务端；服务端用的是与 `relic.autoEquip` 同一个函数，
 *   所以「预览 = 执行」（铁律 #2 / #4）。
 */
const relicAdvice = ref<RelicAdvice | null>(null)

async function loadRelicAdvice() {
  const advice = await store.fetchRelicAdvice(heroId.value)
  relicAdvice.value = advice
}

/** 进页面 / 换英灵时拉一次预览 */
watch(heroId, () => {
  void loadRelicAdvice()
}, { immediate: true })

async function applyRecommendation() {
  const res = await store.autoEquipRelics(heroId.value)
  if (res) relicAdvice.value = res
  await loadRelicAdvice()
}

/**
 * 技能升级按钮的可用性与提示。
 *
 * ⚠ **实施修正（资源/背包版本 v10）**：消耗的是**该英灵五行对应的技能材料**
 *   （金 → 金系技能材料 …，材料 id 取 core 的 `ITEM_BY_ELEMENT`）+ 银两，
 *   不再是单一的术式结晶。这里直接把「差多少」写出来，玩家不必自己换算。
 */
function skillUpHint(index: number): { ok: boolean; text: string } {
  const s = state.value
  if (!s) return { ok: false, text: '' }
  const cur = s.skillLevels[index] ?? 0
  if (cur >= skillLevelCap(s.level)) {
    return { ok: false, text: '当前等级无法继续提升（需先提升英灵等级）' }
  }
  const element = def.value?.element
  if (!element) return { ok: false, text: '' }
  const cost = skillUpCost(cur, element)
  if (!cost) return { ok: false, text: '当前等级无法继续提升' }
  const owned = store.save.items[cost.materialId] ?? 0
  if (owned < cost.material) {
    return {
      ok: false,
      text: `${ITEM_DEFS[cost.materialId].name}不足（${formatNumber(owned)} / ${formatNumber(cost.material)}）`,
    }
  }
  if (store.save.player.silver < cost.silver) {
    return {
      ok: false,
      text: `银两不足（${formatNumber(store.save.player.silver)} / ${formatNumber(cost.silver)}）`,
    }
  }
  return { ok: true, text: '' }
}

/**
 * 技能材料对应的**副本入口**（闭环）。
 *
 * ⚠ 设计稿 §3「材料不足时，养成页直接打开匹配的副本，
 *   并显示差额、每胜产量和返回主线入口」。
 *
 * ⚠ 每胜产量取自 core 的 `dungeonDropAmount`——表现层不自己算（铁律 #4）。
 */
const skillDungeon = computed(() => {
  const element = def.value?.element
  if (!element) return null
  const variant = findDungeonVariant('skill', element)
  if (!variant) return null
  const drop = dungeonDropAmount(variant, 'easy')
  return {
    variant,
    materialName: ITEM_DEFS[variant.itemId].name,
    perWin: `${drop.min} ~ ${drop.max}`,
    query: `/dungeon?kind=skill&element=${element}&difficulty=easy`,
  }
})
</script>

<template>
  <div class="page">
    <div v-if="!def" class="empty">
      未找到该英灵<br />
      <span class="tiny">请返回圣殿重新选择</span>
    </div>

    <template v-else>
      <div class="page-title">{{ def.name }}</div>

      <!-- 基础信息 -->
      <section class="panel">
        <div class="head">
          <img
            :src="def.portrait"
            class="portrait"
            :class="`portrait-${def.rarity.toLowerCase()}`"
            width="132"
            height="176"
            alt=""
          />
          <div class="head-info">
            <div class="row" style="gap: 6px; flex-wrap: wrap">
              <span class="tag" :class="`tag-${def.rarity.toLowerCase()}`">{{ def.rarity }}</span>
              <span class="tag">{{ def.role }}</span>
              <span class="tag" :class="`el-${def.element}`">{{ def.element }}</span>
            </div>
            <div class="tiny muted" style="margin-top: 4px">
              {{ def.era }} · {{ def.region }}
            </div>
            <div class="stars" style="margin-top: 4px">
              <template v-if="state">
                {{ '★'.repeat(state.star) }}<span class="dim">{{ '★'.repeat(6 - state.star) }}</span>
              </template>
              <template v-else>
                <span class="dim">未获得</span>
              </template>
            </div>
          </div>
        </div>

        <template v-if="state">
          <div class="stat-row">
            <div class="row-between tiny">
              <span class="muted">等级</span>
              <b>Lv{{ state.level }}</b>
            </div>
            <div class="row-between tiny">
              <span class="muted">经验</span>
              <span>{{ formatNumber(state.exp) }} / {{ formatNumber(expNeed) }}</span>
            </div>
            <div class="bar" style="margin: 4px 0 6px">
              <i :style="{ width: `${expPct}%` }"></i>
            </div>
            <div class="row-between tiny">
              <span class="muted">境界</span>
              <span>{{ realmLabel }}</span>
            </div>
            <div class="row-between tiny">
              <span class="muted">同名碎片</span>
              <b>{{ formatNumber(shards) }}</b>
            </div>
            <div class="row-between tiny">
              <span class="muted">核心觉醒</span>
              <b>{{ state.coreAwakened ? '已觉醒' : '未觉醒' }}</b>
            </div>
          </div>

          <!-- 属性 -->
          <div v-if="currentStats" class="stat-row">
            <div class="row-between tiny">
              <span class="muted">属性</span>
              <span class="tiny muted">不含羁绊加成</span>
            </div>
            <div class="stat-grid">
              <div v-for="row in statRows" :key="row.key" class="stat-cell" :data-stat="row.key">
                <div class="tiny muted">{{ row.label }}</div>
                <b>{{ formatNumber(row.value) }}</b>
              </div>
            </div>
            <div class="row-between tiny" style="margin-top: 6px">
              <span class="muted">战力</span>
              <b>{{ formatNumber(currentPower) }}</b>
            </div>
          </div>

          <!-- 提升预览：让「升级 / 升星」有明确的收益 -->
          <div v-if="levelPreviews.length > 0 || starGain" class="preview-box">
            <div v-for="p in levelPreviews" :key="p.feed" class="tiny">
              喂 {{ formatNumber(p.feed) }} 经验（升 {{ p.levels }} 级）→
              <span class="ok-text">
                攻 +{{ p.gain.atk }} · 防 +{{ p.gain.def }} · 生命 +{{ p.gain.hp }} · 战力
                +{{ formatNumber(p.gain.power) }}
              </span>
            </div>
            <div v-if="starGain" class="tiny">
              升星 →
              <span class="ok-text">
                攻 +{{ starGain.gain.atk }} · 防 +{{ starGain.gain.def }} · 生命
                +{{ starGain.gain.hp }} · 战力 +{{ formatNumber(starGain.gain.power) }}
              </span>
            </div>
            <div v-if="levelPreviews.length === 0 && !starGain && !realmGate" class="tiny muted">
              当前已无法继续提升等级或星级。
            </div>
          </div>

          <!-- 境界门槛：卡住时给出突破入口 -->
          <div v-if="realmGate" class="preview-box">
            <div class="tiny warn-text">
              已达{{ realmGate.nextName }}门槛（Lv{{ realmGate.cost.targetLevel }}）——需突破境界才能继续升级
            </div>
            <button
              class="btn btn-sm btn-block"
              style="margin-top: 6px"
              data-testid="break-realm"
              :disabled="!realmGate.ok"
              @click="store.breakRealm(heroId)"
            >
              境界突破（银两 {{ formatNumber(realmGate.cost.silver) }}）
            </button>
            <div v-if="!realmGate.ok" class="tiny warn-text" style="margin-top: 3px">
              银两不足（{{ formatNumber(realmGate.silver) }} / {{ formatNumber(realmGate.cost.silver) }}）
            </div>
          </div>

          <!--
            喂经验书（**实施修正 · 资源/背包版本 v10**）：
            玩家经验池退役 → 改为「选书 + 选数量 + 预览 + 使用」。
            预览走 core 的 `previewFeed()`，表现层不自己算能升几级（铁律 #4）。
          -->
          <div class="preview-box" style="margin-top: 8px">
            <div class="tiny muted">喂经验书</div>
            <div class="row" style="gap: 6px; margin-top: 4px; flex-wrap: wrap">
              <button
                v-for="book in bookList"
                :key="book.id"
                class="btn btn-sm"
                :class="{ 'btn-primary': selectedBook === book.id }"
                :data-book="book.id"
                :disabled="(store.save.items[book.id] ?? 0) <= 0"
                @click="selectedBook = book.id"
              >
                {{ book.name }}（{{ formatNumber(store.save.items[book.id] ?? 0) }}）
              </button>
            </div>
            <div class="row" style="gap: 6px; margin-top: 6px; align-items: center">
              <span class="tiny muted">数量</span>
              <input
                v-model.number="feedCount"
                class="input"
                type="number"
                min="1"
                :max="Math.max(1, bookOwned)"
                data-testid="feed-count"
                style="width: 90px"
              />
              <button
                class="btn btn-sm"
                :disabled="bookOwned <= 0"
                data-testid="feed-max"
                @click="feedCount = Math.max(1, bookOwned)"
              >
                最大
              </button>
            </div>
            <div v-if="feedPreview" class="tiny muted" style="margin-top: 4px" data-testid="feed-preview">
              预计：投入 {{ formatNumber(feedPreview.applied) }} 经验
              <template v-if="feedPreview.levelsGained > 0">
                · 提升 {{ feedPreview.levelsGained }} 级
              </template>
              <template v-else-if="feedPreview.blockedByRealm">· 已达境界门槛</template>
              <template v-else>· 不足以升 1 级</template>
              <template v-if="feedPreview.expRemaining > 0">
                · 存于该英灵 {{ formatNumber(feedPreview.expRemaining) }} 经验
              </template>
            </div>
            <div v-if="!feedHint().ok" class="tiny warn-text" style="margin-top: 3px">
              {{ feedHint().text }}
            </div>
            <button
              class="btn btn-sm btn-primary btn-block"
              style="margin-top: 6px"
              data-testid="feed-books"
              :disabled="!feedHint().ok"
              @click="store.feedBooks(heroId, selectedBook, feedCount)"
            >
              使用{{ ITEM_DEFS[selectedBook].name }} ×{{ feedCount }}
            </button>
          </div>

          <button
            class="btn btn-sm btn-block"
            style="margin-top: 6px"
            :disabled="!starCost || shards < starCost.shards"
            data-testid="upgrade-star"
            @click="store.upgradeStar(heroId)"
          >
            升星
            <template v-if="starCost">
              （同名碎片 {{ starCost.shards }}）
            </template>
            <template v-else>（已达上限）</template>
          </button>
        </template>

        <div v-else class="empty" style="padding: 16px">
          尚未获得该英灵<br />
          <span class="tiny">可前往召唤获取</span>
        </div>
      </section>

      <!-- 技能 -->
      <section class="panel">
        <div class="panel-title"><span>技能</span></div>
        <div v-for="(skill, i) in def.skills" :key="skill.id" class="skill">
          <div class="row-between">
            <div class="row" style="gap: 6px">
              <b class="skill-name">{{ skill.name }}</b>
              <span class="tag">{{ skill.kind === 'ultimate' ? '终极技' : skill.kind === 'battle' ? '战技' : '普攻' }}</span>
            </div>
            <span v-if="state" class="tag tag-sr">Lv{{ state.skillLevels[i] }}</span>
          </div>
          <div class="tiny muted" style="margin-top: 3px">{{ skill.desc }}</div>
          <div class="row-between tiny muted" style="margin-top: 3px">
            <span>冷却 {{ skill.cooldown }} 回合</span>
            <span>解锁：{{ skill.unlockStar }}★ · Lv{{ skill.unlockLevel }}</span>
          </div>
          <button
            v-if="state"
            class="btn btn-sm btn-block"
            style="margin-top: 6px"
            :disabled="!skillUpHint(i).ok"
            @click="store.upgradeSkill(heroId, i)"
          >
            提升等级（{{ skillMaterialName }} {{ SKILL.MATERIAL_PER_LEVEL }} · 银两
            {{ formatNumber(SKILL.SILVER_PER_LEVEL) }}）
          </button>
          <div v-if="state && !skillUpHint(i).ok" class="tiny warn-text" style="margin-top: 3px">
            {{ skillUpHint(i).text }}
          </div>
          <!--
            闭环（设计稿 §3）：材料不足时**直接打开匹配的副本**，
            并显示「每胜产量」——玩家不必自己换算缺多少。
          -->
          <div v-if="state && skillDungeon" class="tiny muted" style="margin-top: 4px">
            {{ skillDungeon.materialName }} 来源：{{ skillDungeon.variant.name }} · 每胜
            {{ skillDungeon.perWin }} 个
            <button class="btn btn-sm btn-ghost" style="margin-left: 6px" @click="router.push(skillDungeon.query)">
              前往副本
            </button>
          </div>
        </div>
      </section>

      <!-- 被动 -->
      <section class="panel">
        <div class="panel-title"><span>星级被动</span></div>
        <div v-for="passive in def.passives" :key="passive.id" class="skill">
          <div class="row-between">
            <b class="skill-name">{{ passive.name }}</b>
            <span class="tag" :class="state && state.star >= passive.unlockStar ? 'tag-sr' : ''">
              {{ passive.unlockStar }}★ 解锁
            </span>
          </div>
          <div class="tiny muted" style="margin-top: 3px">{{ passive.desc }}</div>
        </div>
      </section>

      <!-- 遗物槽 -->
      <section class="panel">
        <div class="panel-title">
          <span>遗物槽</span>
          <span class="tiny muted">{{ relicSlots.filter(Boolean).length }} / {{ RELIC_SLOT_COUNT }}</span>
        </div>
        <div class="relic-grid">
          <button
            v-for="(relic, slot) in relicSlots"
            :key="slot"
            class="relic-slot"
            :class="{ filled: !!relic }"
            @click="relic ? (menuSlot = menuSlot === slot ? null : slot) : openPicker(slot)"
          >
            <img
              v-if="relic"
              class="relic-icon"
              :src="relicIconPath(relic.defId)"
              :alt="relicName(relic)"
              width="36"
              height="36"
              loading="lazy"
            />
            <span class="tiny">{{ slot + 1 }}</span>
            <span v-if="relic" class="relic-name">{{ relicName(relic) }}</span>
            <span v-else class="tiny dim">空</span>
            <span v-if="relic" class="tiny muted">
              {{ RELIC_SETS.get(RELIC_DEFS.get(relic.defId)?.setId ?? '')?.name ?? '—' }} · Lv{{ relic.level }}
            </span>
          </button>
        </div>

        <!-- 一键推荐装备 -->
        <button
          class="btn btn-sm btn-block"
          style="margin-top: 8px"
          data-testid="relic-recommend"
          :disabled="!relicAdvice || relicAdvice.gain <= 0"
          @click="applyRecommendation"
        >
          <template v-if="relicAdvice && relicAdvice.gain > 0">
            一键推荐装备（战力 +{{ formatNumber(relicAdvice.gain) }}）
          </template>
          <template v-else>一键推荐装备</template>
        </button>
        <div v-if="relicAdvice && relicAdvice.gain <= 0" class="tiny muted" style="margin-top: 4px">
          当前已是最优配置（仓库里没有更强的遗物可换）。
        </div>
        <div v-else class="tiny muted" style="margin-top: 4px">
          推荐只在未装备在其他英灵身上的遗物中挑选，不会抢走别人的装备。
        </div>

        <p class="tiny muted" style="margin: 8px 0 0">
          点击空槽选择遗物，点击已装备遗物可强化、分解或卸下。
        </p>
      </section>

      <!-- 套装效果（2 / 4 / 6 件阶梯加成） -->
      <section class="panel">
        <div class="panel-title">
          <span>套装效果</span>
          <span class="tiny muted">{{ setRows.length ? `${setRows.length} 套在身` : '无' }}</span>
        </div>
        <div v-if="setRows.length === 0" class="empty" style="padding: 14px">
          尚未装备套装件<br />
          <span class="tiny">同套装装备 2 / 4 / 6 件可激活阶梯加成</span>
        </div>
        <div v-for="row in setRows" :key="row.setId" class="set-row">
          <div class="row-between">
            <b>{{ row.name }}</b>
            <span class="tag" :class="row.tiers.some((t) => t.active) ? 'tag-sr' : ''">
              {{ row.count }} 件
            </span>
          </div>
          <div class="tiny muted" style="margin-top: 2px">{{ row.desc }}</div>
          <div
            v-for="tier in row.tiers"
            :key="tier.pieces"
            class="tiny"
            :class="tier.active ? 'ok-text' : 'muted'"
          >
            {{ tier.pieces }} 件 · {{ tier.desc }}
            <template v-if="tier.active">（已生效）</template>
            <template v-else-if="tier.need > 0">（还差 {{ tier.need }} 件）</template>
          </div>
          <div v-if="row.spare > 0" class="tiny muted" style="margin-top: 2px">
            仓库里还有 {{ row.spare }} 件「{{ row.name }}」可换
            <template v-if="row.nextNeed > 0">（换上即可补齐 {{ row.nextPieces }} 件套）</template>
          </div>
        </div>
      </section>

      <!-- 羁绊 -->
      <section class="panel">
        <div class="panel-title"><span>羁绊</span></div>
        <div v-if="heroBonds.length === 0" class="empty" style="padding: 16px">暂无相关羁绊</div>
        <div v-for="b in heroBonds" :key="b.bond.id" class="bond">
          <div class="row-between">
            <b>{{ b.bond.name }}</b>
            <span class="tag" :class="b.active ? 'tag-sr' : ''">
              {{ b.active ? '已激活' : `未激活 ${b.count}` }}
            </span>
          </div>
          <div class="tiny muted" style="margin-top: 3px">{{ b.bond.desc }}</div>
        </div>
      </section>

      <!-- 传记 -->
      <section class="panel">
        <div class="panel-title"><span>传记</span></div>
        <p v-for="(para, i) in def.bio" :key="i" class="bio">{{ para }}</p>
      </section>

      <button class="btn btn-block btn-ghost" @click="router.back()">返回</button>
    </template>

    <!-- 遗物选择器 -->
    <div v-if="pickerOpen" class="mask" @click.self="pickerOpen = false">
      <div class="dialog">
        <div class="panel-title">
          <span>选择遗物 · 第 {{ pickerSlot + 1 }} 槽</span>
          <button class="btn btn-sm btn-ghost" @click="pickerOpen = false">关闭</button>
        </div>
        <div v-if="pickerLoading" class="empty">加载中…</div>
        <div v-else-if="pickerItems.length === 0" class="empty">遗物仓库为空</div>
        <button
          v-for="r in pickerItems"
          :key="r.uid"
          class="list-item pick-row"
          @click="chooseRelic(r.uid)"
        >
          <img
            class="relic-icon"
            :src="relicIconPath(r.defId)"
            :alt="relicName(r)"
            width="36"
            height="36"
            loading="lazy"
          />
          <div style="flex: 1; min-width: 0">
            <div class="row" style="gap: 6px">
              <span class="tag" :class="`tag-${(RELIC_DEFS.get(r.defId)?.rarity ?? 'N').toLowerCase()}`">
                {{ RELIC_DEFS.get(r.defId)?.rarity ?? 'N' }}
              </span>
              <b>{{ relicName(r) }}</b>
            </div>
            <div class="tiny muted" style="margin-top: 2px">
              {{ RELIC_SETS.get(RELIC_DEFS.get(r.defId)?.setId ?? '')?.name ?? '—' }} · 强化 +{{ r.level }}
            </div>
          </div>
          <span class="tiny muted">装备</span>
        </button>
        <div class="row-between" style="margin-top: 8px">
          <button class="btn btn-sm btn-ghost" :disabled="pickerPage <= 1" @click="loadPicker(pickerPage - 1)">
            上一页
          </button>
          <span class="tiny muted">共 {{ pickerTotal }} 件 · {{ pickerPage }} / {{ pickerPages }}</span>
          <button class="btn btn-sm btn-ghost" :disabled="pickerPage >= pickerPages" @click="loadPicker(pickerPage + 1)">
            下一页
          </button>
        </div>
      </div>
    </div>

    <!-- 已装备遗物的操作 -->
    <div v-if="menuRelic" class="mask" @click.self="menuSlot = null">
      <div class="dialog">
        <div class="panel-title">
          <span>{{ relicName(menuRelic) }}</span>
          <button class="btn btn-sm btn-ghost" @click="menuSlot = null">关闭</button>
        </div>
        <div class="tiny muted" style="margin-bottom: 10px">
          强化 +{{ menuRelic.level }} · 槽位 {{ (menuSlot ?? 0) + 1 }}
        </div>
        <div class="row" style="gap: 6px; flex-wrap: wrap">
          <button
            class="btn btn-sm"
            style="flex: 1"
            data-testid="relic-upgrade"
            :disabled="!menuUpgrade.ok"
            @click="upgradeRelic(menuRelic.uid)"
          >
            强化 +{{ menuRelic.level + 1 }}
          </button>
          <button class="btn btn-sm" style="flex: 1" @click="unequip(menuSlot ?? 0)">卸下</button>
          <button
            class="btn btn-sm btn-danger"
            style="flex: 1"
            @click="askDecompose(menuRelic)"
          >
            分解
          </button>
        </div>
        <div v-if="menuUpgrade.cost" class="tiny muted" style="margin-top: 4px">
          强化消耗：银两 {{ formatNumber(menuUpgrade.cost.silver) }} · {{ menuStoneCostText }}
        </div>
        <div v-if="menuUpgrade.cost && !menuUpgrade.ok" class="tiny warn-text" style="margin-top: 2px">
          {{ menuUpgrade.text }}
        </div>
      </div>
    </div>

    <!-- 分解二次确认 -->
    <div v-if="confirmRelic" class="mask" @click.self="confirmRelic = null">
      <div class="dialog">
        <div class="panel-title">分解确认</div>
        <p class="tiny muted" style="margin: 0 0 10px; line-height: 1.8">
          分解后该遗物会被移除，对应槽位同时清空，返还银两（不返还副本材料）。
        </p>
        <div class="row" style="gap: 8px">
          <button class="btn btn-sm" style="flex: 1" @click="confirmRelic = null">取消</button>
          <button class="btn btn-sm btn-danger" style="flex: 1" @click="doDecompose">确认分解</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.head-info {
  flex: 1;
  min-width: 0;
}

.stat-row {
  margin-top: 12px;
  padding: 10px;
  border-radius: 8px;
  background: var(--c-bg-2);
  border: 1px solid var(--c-line);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* 属性四宫格 */
.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
  margin-top: 4px;
}

.stat-cell {
  padding: 5px 4px;
  border-radius: 6px;
  background: var(--c-panel);
  text-align: center;
  line-height: 1.4;
}

.stat-cell b {
  font-size: 13px;
}

/* 提升预览 */
.preview-box {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px dashed var(--c-line-2);
  background: var(--c-bg-2);
  display: flex;
  flex-direction: column;
  gap: 4px;
  line-height: 1.6;
}

.ok-text {
  color: var(--c-green);
}

.warn-text {
  color: #e0a06a;
}

.skill {
  padding: 8px 0;
  border-bottom: 1px solid var(--c-line);
}

.skill:last-child {
  border-bottom: none;
}

.skill-name {
  font-size: 13px;
}

.bio {
  margin: 0 0 8px;
  font-size: 13px;
  line-height: 1.75;
  color: var(--c-text-dim);
  text-indent: 2em;
}

.bond {
  padding: 6px 0;
  border-bottom: 1px solid var(--c-line);
}

.bond:last-child {
  border-bottom: none;
}

.relic-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
}

.relic-slot {
  min-height: 62px;
  padding: 6px 4px;
  border-radius: 8px;
  border: 1px dashed var(--c-line-2);
  background: var(--c-bg-2);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  text-align: center;
}

.relic-slot.filled {
  border-style: solid;
  border-color: var(--c-gold);
  background: #2a2419;
}

.relic-icon {
  width: 36px;
  height: 36px;
  /* 同 ForgeView：AI 遗物图为方形满幅，圆裁会切掉器物。 */
  border-radius: 5px;
  object-fit: cover;
  display: block;
  flex: none;
  background: #0d0d14;
}

.set-row {
  padding: 8px 0;
  border-bottom: 1px solid var(--c-line);
  line-height: 1.7;
}

.set-row:last-child {
  border-bottom: none;
}

.relic-name {
  font-size: 12px;
  color: var(--c-gold-2);
  line-height: 1.3;
}

.dim {
  color: var(--c-text-mute);
}

.pick-row {
  width: 100%;
  text-align: left;
}

.stars {
  font-size: 12px;
  color: var(--c-gold);
  letter-spacing: -1px;
}
</style>
