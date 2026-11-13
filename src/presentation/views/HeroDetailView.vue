<script setup lang="ts">
/**
 * 英灵详情：属性 / 技能 / 被动 / 传记 / 羁绊 / 遗物槽。
 * 规则一律取自 core，组件只做展示与调用 store 的 action。
 */
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useGameStore } from '../stores/game'
import { HERO_INDEX } from '../../core/config/heroes/index.ts'
import { BONDS } from '../../core/config/bonds.ts'
import { SKILL } from '../../core/config/economy.ts'
import {
  expToNext,
  starUpCost,
  applyExp,
  getHeroPassiveMods,
  skillLevelCap,
} from '../../core/systems/growth.ts'
import { RELIC_DEFS, getHeroSetMods } from '../../core/systems/relic.ts'
import { resolveStats, computePower } from '../../core/systems/stats.ts'
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

/** 喂经验的档位（单位：经验） */
const EXP_FEEDS = [1000, 10000, 100000]

/** 升级后的下一级所需经验（用于经验条） */
const expNeed = computed(() => (state.value ? expToNext(state.value.level) : 0))
const expPct = computed(() => {
  if (!state.value || expNeed.value <= 0) return 0
  return Math.min(100, (state.value.exp / expNeed.value) * 100)
})

/** 升星消耗 */
const starCost = computed(() => (state.value ? starUpCost(state.value.star) : null))
const shards = computed(() => store.save.player.shards[heroId.value] ?? 0)

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
 */
const levelPreviews = computed(() => {
  const rt = runtime.value
  const cur = currentStats.value
  if (!rt || !cur) return []
  const out: { feed: number; levels: number; gain: ReturnType<typeof gainOf> }[] = []
  for (const feed of EXP_FEEDS) {
    const clone: HeroRuntime = { ...rt, state: { ...rt.state } }
    const res = applyExp(clone.state, feed)
    if (res.levelsGained <= 0) continue
    out.push({ feed, levels: res.levelsGained, gain: gainOf(statsOf(clone), cur) })
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

/** 已装备遗物的操作菜单 */
const menuSlot = ref<number | null>(null)

/** 菜单当前对应的遗物 */
const menuRelic = computed(() =>
  menuSlot.value === null ? null : (relicSlots.value[menuSlot.value] ?? null),
)

/** 分解二次确认 */
const confirmRelic = ref<RelicInstance | null>(null)

function openPicker(slot: number) {
  pickerSlot.value = slot
  menuSlot.value = null
  pickerOpen.value = true
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

/**
 * 技能升级按钮的可用性与提示。
 *
 * ⚠ 消耗的是**术式结晶**（skillStones），与圣杯结晶是两回事；
 *   这里直接把「差多少」写出来，玩家不必自己换算。
 */
function skillUpHint(index: number): { ok: boolean; text: string } {
  const s = state.value
  if (!s) return { ok: false, text: '' }
  const cur = s.skillLevels[index] ?? 0
  if (cur >= skillLevelCap(s.level)) {
    return { ok: false, text: '当前等级无法继续提升（需先提升英灵等级）' }
  }
  const p = store.save.player
  if (p.skillStones < SKILL.SKILL_STONES_PER_LEVEL) {
    return {
      ok: false,
      text: `术式结晶不足（${formatNumber(p.skillStones)} / ${SKILL.SKILL_STONES_PER_LEVEL}）`,
    }
  }
  if (p.silver < SKILL.SILVER_PER_LEVEL) {
    return {
      ok: false,
      text: `银两不足（${formatNumber(p.silver)} / ${formatNumber(SKILL.SILVER_PER_LEVEL)}）`,
    }
  }
  return { ok: true, text: '' }
}
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
            <div v-if="levelPreviews.length === 0 && !starGain" class="tiny muted">
              当前已无法继续提升等级或星级。
            </div>
          </div>

          <!-- 养成 -->
          <div class="row" style="margin-top: 10px; gap: 6px; flex-wrap: wrap">
            <button
              v-for="n in EXP_FEEDS"
              :key="n"
              class="btn btn-sm"
              style="flex: 1; min-width: 96px"
              @click="store.feedExp(heroId, n)"
            >
              喂 {{ formatNumber(n) }} 经验
            </button>
          </div>
          <button
            class="btn btn-sm btn-block"
            style="margin-top: 6px"
            :disabled="!starCost || shards < starCost.shards || store.save.player.emblems < starCost.emblems"
            @click="store.upgradeStar(heroId)"
          >
            升星
            <template v-if="starCost">
              （碎片 {{ starCost.shards }} · 印记 {{ starCost.emblems }}）
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
            提升等级（术式结晶 {{ SKILL.SKILL_STONES_PER_LEVEL }} · 银两
            {{ formatNumber(SKILL.SILVER_PER_LEVEL) }}）
          </button>
          <div v-if="state && !skillUpHint(i).ok" class="tiny warn-text" style="margin-top: 3px">
            {{ skillUpHint(i).text }}
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
            <span class="tiny">{{ slot + 1 }}</span>
            <span v-if="relic" class="relic-name">{{ relicName(relic) }}</span>
            <span v-else class="tiny dim">空</span>
            <span v-if="relic" class="tiny muted">Lv{{ relic.level }}</span>
          </button>
        </div>
        <p class="tiny muted" style="margin: 8px 0 0">
          点击空槽选择遗物，点击已装备遗物可强化、分解或卸下。
        </p>
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
        <div v-if="store.save.relics.length === 0" class="empty">遗物仓库为空</div>
        <button
          v-for="r in store.save.relics"
          :key="r.uid"
          class="list-item pick-row"
          @click="chooseRelic(r.uid)"
        >
          <div style="flex: 1; min-width: 0">
            <div class="row" style="gap: 6px">
              <span class="tag" :class="`tag-${(RELIC_DEFS.get(r.defId)?.rarity ?? 'N').toLowerCase()}`">
                {{ RELIC_DEFS.get(r.defId)?.rarity ?? 'N' }}
              </span>
              <b>{{ relicName(r) }}</b>
            </div>
            <div class="tiny muted" style="margin-top: 2px">强化 +{{ r.level }}</div>
          </div>
          <span class="tiny muted">装备</span>
        </button>
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
          <button class="btn btn-sm" style="flex: 1" @click="upgradeRelic(menuRelic.uid)">强化</button>
          <button class="btn btn-sm" style="flex: 1" @click="unequip(menuSlot ?? 0)">卸下</button>
          <button
            class="btn btn-sm btn-danger"
            style="flex: 1"
            @click="askDecompose(menuRelic)"
          >
            分解
          </button>
        </div>
      </div>
    </div>

    <!-- 分解二次确认 -->
    <div v-if="confirmRelic" class="mask" @click.self="confirmRelic = null">
      <div class="dialog">
        <div class="panel-title">分解确认</div>
        <p class="tiny muted" style="margin: 0 0 10px; line-height: 1.8">
          分解后该遗物会被移除，对应槽位同时清空，返还银两与强化石。
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
