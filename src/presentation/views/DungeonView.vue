<script setup lang="ts">
/**
 * 副本（技能副本 / 强化副本 / **遗物副本**）——**42 个独立关卡**（挂机改版 v11 + 遗物副本 v12）。
 *
 * ## 副本是独立关卡
 *
 * `(变体 × 难度) = 1 关`，共 5 技能变体 × 3 难度 + 3 强化变体 × 3 难度
 * + **6 遗物变体 × 3 难度** = **42 关**。
 * 每关有自己的敌人组合、缩放锚点、战力门槛与产量，**打赢一次即通关**。
 *
 * ## 三种副本的产出形状不同
 *
 * - **技能 / 强化副本**：产出**堆叠物**（`stage.drop`）→ 材料副本的老逻辑。
 * - **遗物副本**（存档 v12）：产出**遗物实例**（`stage.drop === null`，
 *   改走 `stage.relicPool`）——遗物是实物，不是道具。
 *
 * ⚠ 所以「读 `stage.drop.xxx`」的地方**一律要判空**：
 *   遗物副本的 `drop` 就是 `null`，不判空会直接崩在模板里。
 *
 * ## 挂机
 *
 * 副本是**三条挂机通道之一**（技能 / 强化 / **遗物**），与主线**各自独立**计量。
 * 只有**已通关**的副本关卡才能设为挂机目标（挂机只挂已通关内容）。
 *
 * ⚠ **规则一律取 core**（铁律 #2 / #4）：
 *   - 关卡定义 → `core/config/dungeons.ts`；
 *   - 解锁判定 → `core/systems/dungeons.ts` 的 `dungeonStageUnlocked`；
 *   - 稀有度概率公示 → `core/systems/relic.ts` 的 `relicDropRates`（**唯一一份**）；
 *   - 每日额度 → `core/systems/relic.ts` 的 `relicQuotaLeft`。
 */
import { computed, nextTick, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useGameStore } from '../stores/game'
import {
  DUNGEON_DIFFICULTY_ORDER,
  DUNGEON_INDEX,
  DUNGEON_VARIANT_ORDER,
  dungeonStagesOf,
  dungeonStagesOfVariant,
  findDungeonVariant,
  findRelicDungeonVariant,
  type DungeonKind,
  type DungeonStageDef,
  type DungeonVariant,
} from '../../core/config/dungeons.ts'
import {
  DUNGEON_DIFFICULTIES,
  RELIC_DROP,
  type DungeonDifficultyId,
  type RelicStoneTierId,
} from '../../core/config/economy.ts'
import type { Element } from '../../core/model/types.ts'
import { dungeonStageUnlocked } from '../../core/systems/dungeons.ts'
import { RELIC_DEFS, RELIC_SETS, relicDropRates, relicQuotaLeft } from '../../core/systems/relic.ts'
import { relicIdsBySet } from '../../core/config/relics.ts'
import { ITEM_DEFS } from '../../core/config/items.ts'
import { resourceIconPath } from '../../core/config/art.ts'
import { formatNumber, formatPower } from '../utils/format'
import ChallengeReplay from '../components/ChallengeReplay.vue'

const store = useGameStore()
const route = useRoute()
const router = useRouter()

function queryValue(key: string): string | undefined {
  const raw = route.query[key]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' ? value : undefined
}

/**
 * 副本种类（tab）。
 *
 * ⚠ 遗物副本是**第三个** tab（存档 v12）：`?kind=relic`。
 * ⚠ 深链 `?relic=<setId>` 自带语义 —— 即使没写 `kind=relic` 也落在遗物副本页，
 *   否则「仓库 → 点某个套装 → 直达对应副本」这条链会在技能副本页上打开（入口形同虚设）。
 */
const kind = computed<DungeonKind>(() => {
  const raw = queryValue('kind')
  if (raw === 'enhance' || raw === 'relic') return raw
  if (queryValue('relic')) return 'relic'
  return 'skill'
})

/**
 * **深链指定的变体**（背包页「去副本」会带 `?element=…` / `?tier=…`；
 * 遗物仓库会带 `?relic=<setId>`）。
 *
 * ⚠ 解析走 core 的 `findDungeonVariant` / `findRelicDungeonVariant`（唯一出处，铁律 #3 / #8）——
 *   表现层不得自己拼变体 id。
 * ⚠ **遗物副本的定位键是「套装」**，不走 element / tier 那条路：
 *   套装 → 副本的映射由 core 独家产出（`findRelicDungeonVariant`）。
 *
 * 命中时该变体的关卡**高亮并滚到视野内**：点「去副本」要真的看到对应关卡，
 * 否则「入口可达」只是 URL 变了（铁律 #27 的反面）。
 */
const focusVariant = computed(() => {
  if (kind.value === 'relic') {
    const setId = queryValue('relic')
    if (!setId) return null
    return findRelicDungeonVariant(setId)?.id ?? null
  }
  const variant = findDungeonVariant(
    kind.value,
    queryValue('element') as Element | undefined,
    queryValue('tier') as RelicStoneTierId | undefined,
  )
  return variant?.id ?? null
})

/** 当前种类下的全部关卡（按难度段 × 变体排列） */
const stages = computed(() => dungeonStagesOf(kind.value))

/** 按难度段分组（简易 / 普通 / 困难）——材料副本用 */
const groups = computed(() =>
  DUNGEON_DIFFICULTY_ORDER.map((difficulty) => ({
    difficulty,
    name: DUNGEON_DIFFICULTIES.find((d) => d.id === difficulty)?.name ?? difficulty,
    stages: stages.value.filter((s) => s.difficulty === difficulty),
  })),
)

/**
 * **遗物副本的变体列表**（6 个，按 `DUNGEON_VARIANT_ORDER` 的固定顺序）。
 *
 * ⚠ 遗物副本按**副本**分组展示（材料副本按难度段分组）：
 *   一个副本覆盖 **2 个套装**，玩家关心的是「这个副本给我哪两套」，
 *   按难度段切开会把这个信息拆散（套装进度就无处安放）。
 */
const relicVariants = computed<DungeonVariant[]>(() =>
  DUNGEON_VARIANT_ORDER.map((id) => DUNGEON_INDEX.get(id))
    .filter((v): v is DungeonVariant => !!v && v.kind === 'relic'),
)

/** 该副本关卡是否已通关 */
function isCleared(stage: DungeonStageDef): boolean {
  return store.save.dungeons.cleared[stage.id] === true
}

/**
 * 解锁判定（core 独家口径）。
 *
 * ⚠ **强化副本的解锁线必须用服务端统计的仓库最高等级**：
 *   客户端镜像里 `save.relics` 只有**已装备**件（存档分包），
 *   仓库里那件 Lv60 的客户端看不见 → 直接用 `save.relics` 会把
 *   「已解锁」误判成「未解锁」（玩家明明有 Lv60 却点不了按钮）。
 */
function unlockOf(stage: DungeonStageDef) {
  const variant = DUNGEON_INDEX.get(stage.variantId)
  if (!variant) return { unlocked: false, reason: '副本配置异常', hintRoute: 'dungeon' }
  if (variant.kind === 'enhance' && !store.relicStatsLoaded) {
    return {
      unlocked: false,
      reason: store.offline ? '离线状态下读不到仓库信息' : '正在读取仓库信息…',
      hintRoute: 'forge',
    }
  }
  return dungeonStageUnlocked(store.save, stage, { maxRelicLevel: store.relicStats.maxLevel })
}

/** 通道名（提示文案用；「主线」在别的页面，这里只有三条副本通道） */
const CHANNEL_LABELS: Record<'skill' | 'enhance' | 'relic', string> = {
  skill: '技能',
  enhance: '强化',
  relic: '遗物',
}

/**
 * 某条通道当前挂的是不是这一关。
 *
 * ⚠ **通道种类必须从配置取**（`DUNGEON_INDEX.get(stage.variantId)?.kind`）：
 *   旧实现用 `stage.variantId.startsWith('skill') ? 'skill' : 'enhance'` 推断——
 *   遗物副本的变体 id 是 `relicZhanTan` 之类，`startsWith('skill')` 为 false
 *   ⇒ 遗物关卡被当成「强化通道」，界面上永远显示「未挂机」。
 *   教训：**变体 id 的前缀不是分类依据**（铁律 #3：配置是唯一出处）。
 */
function isIdleTarget(stage: DungeonStageDef): boolean {
  const channelKind = DUNGEON_INDEX.get(stage.variantId)?.kind
  if (!channelKind) return false
  const t = store.save.idle.channels[channelKind].target
  if (!t) return false
  return (
    (t.kind === 'skill' || t.kind === 'enhance' || t.kind === 'relic') &&
    t.dungeonStageId === stage.id
  )
}

/**
 * 这是不是**强化副本**（解锁线 = 「持有 LvN 遗物」）。
 */
function isEnhanceStage(stage: DungeonStageDef): boolean {
  return DUNGEON_INDEX.get(stage.variantId)?.kind === 'enhance'
}

/**
 * **「出路按钮」只挂一处**（每个 tab 最多一个）。
 *
 * ⚠ 强化副本被「持有 LvN 遗物」这条解锁线挡住时，玩家必须**当场**有出路
 *   （铁律 #10 / #27）；但九个强化关卡各挂一个 ⇒ 同一个 testid 命中 9 个元素，
 *   E2E 的严格模式直接报「resolved to 9 elements」。
 *   ⇒ 挂在**当前 tab 里第一个被挡住的关卡**上：玩家从上往下扫，
 *   第一个挡路的那一条就是真正卡住他的那一条。
 */
const firstBlockedEnhanceStageId = computed(() => {
  for (const g of groups.value) {
    for (const stage of g.stages) {
      if (isEnhanceStage(stage) && !unlockOf(stage).unlocked) return stage.id
    }
  }
  return null
})

/** 遗物副本同理：解锁线是「主线通关第 N 关」，出路按钮也只挂一处 */
const firstBlockedRelicStageId = computed(() => {
  for (const variant of relicVariants.value) {
    for (const stage of dungeonStagesOfVariant(variant.id)) {
      if (!unlockOf(stage).unlocked) return stage.id
    }
  }
  return null
})

/**
 * 去**遗物副本**（遗物的唯一来源）。
 *
 * ⚠ 强化副本的解锁线是「持有 LvN 遗物」，玩家在这里被挡住时
 *   必须**当场给一条出路**——否则只剩一句「需要持有 Lv1 遗物」的死路提示
 *   （铁律 #10：核心循环入口必须可达；铁律 #27：养成规则要写在玩家眼前）。
 *
 * ⚠ 存档 v12 起遗物**不再**由「花银两祈愿」获得（那条路已下线），
 *   所以出路只能是**遗物副本**：主线第 1 关就能进第一个副本。
 */
function goRelicDungeon() {
  void router.push({ path: '/dungeon', query: { kind: 'relic' } })
}

/**
 * **今日剩余遗物额度**（件）。
 *
 * ⚠ 走 core 的 `relicQuotaLeft`（**唯一一份**）：它按 **UTC 日期键**判定，
 *   客户端与服务端时区不同也能对上；表现层不自己算「今天是不是新的一天」。
 * ⚠ 时间取**注入时钟**（`store.now()`），禁止 `Date.now()`（铁律 #12）。
 */
const quotaLeft = computed(() => relicQuotaLeft(store.save, store.now()))

/**
 * 稀有度概率**公示**（每个难度档一份）。
 *
 * ⚠ 取 core 的 `relicDropRates`（**唯一一份**：与实际抽签 `rollRelicDrop` 同源）——
 *   表现层**禁止**自己拿 `RELIC_DROP.RATES` 换算百分比（铁律 #4：公示 = 实际）。
 */
function ratesOf(difficulty: DungeonDifficultyId) {
  return relicDropRates(difficulty)
}

/**
 * 百分比文本（公示用）。
 *
 * ⚠ 先四舍五入到两位小数再判整数：0.45 × 100 在浮点里是 45.00000000000001，
 *   直接判 `% 1 === 0` 会把「45%」印成「45.0%」。
 */
function percentText(percent: number): string {
  const pct = Math.round(percent * 100 * 100) / 100
  return `${Number.isInteger(pct) ? String(pct) : pct.toFixed(2).replace(/0+$/, '')}%`
}

/** 难度档名（简易 / 普通 / 困难） */
function difficultyName(difficulty: DungeonDifficultyId): string {
  return DUNGEON_DIFFICULTIES.find((d) => d.id === difficulty)?.name ?? difficulty
}

/** 某套装共有几件（配置口径：`relicIdsBySet`） */
function setTotalOf(setId: string): number {
  return relicIdsBySet(setId).length
}

/** 某套装在仓库里已有几件（**服务端口径**的套装统计，store 独家产出） */
function setCountOf(setId: string): number {
  return store.relicSetCounts.get(setId) ?? 0
}

/**
 * 保底进度（该关卡连续未出 SSR 的件数）。
 *
 * ⚠ 保底**按「件」计**（不是按「场」）：一件遗物 = 一次抽签。
 * ⚠ 计数取存档里的 `save.relicPity`（服务端落盘，刷新页面不会重置）。
 */
function pityOf(stage: DungeonStageDef): number {
  return store.save.relicPity[stage.id] ?? 0
}

/** 还差几件必出 SSR */
function pityRemain(stage: DungeonStageDef): number {
  return Math.max(0, RELIC_DROP.PITY_SSR - pityOf(stage))
}

/** 遗物副本每胜产出件数（区间，来自 `RELIC_DROP.COUNT`） */
function relicCountText(difficulty: DungeonDifficultyId): string {
  const range = RELIC_DROP.COUNT[difficulty]
  return range.min === range.max ? `${range.min}` : `${range.min}~${range.max}`
}

/**
 * 进页面先拉一次仓库统计 + 刷新一次存档镜像。
 *
 * ⚠ 强化副本的解锁线要「仓库里的最高等级」，而客户端镜像里只有已装备遗物 →
 *   这份统计只能问服务端（`GET /api/relics/stats`）。
 * ⚠ 遗物副本的**套装进度**也读这份统计（仓库件数客户端算不出来）。
 * ⚠ **刷新存档镜像**：副本通关记录可能刚在**另一条链路**上更新过
 *   （另一台设备打赢的副本）——镜像不刷新的话，「已通关」会显示成「未通关」，
 *   「设为挂机通道」按钮一直禁用 ⇒ 玩家以为功能坏了（铁律 #10）。
 */
onMounted(() => {
  void store.loadRelicStats()
  void store.refreshSave()
  void scrollToFocus()
})

/** 深链命中变体时，把它的关卡滚到视野内（找不到就什么都不做） */
async function scrollToFocus(): Promise<void> {
  if (!focusVariant.value) return
  await nextTick()
  const el = document.querySelector<HTMLElement>(`[data-variant="${focusVariant.value}"]`)
  try {
    el?.scrollIntoView({ block: 'center' })
  } catch {
    // 滚动失败不影响功能（高亮已经标出来了）
  }
}

// ⚠ 切 tab 时要把**另一个 tab 的定位参数**一起清掉：
//   `?element` / `?tier` 只对材料副本有意义，`?relic` 只对遗物副本有意义。
//   留着旧参数会让深链焦点落在别的 tab 上（界面高亮的副本不是玩家点进来的那个）。
watch([kind, focusVariant], () => {
  void scrollToFocus()
})

function switchKind(next: DungeonKind) {
  void router.replace({ path: route.path, query: { kind: next } })
}

/** **手动挑战**一个副本关卡（打赢一次即通关） */
async function challenge(stage: DungeonStageDef) {
  if (store.teamEmpty) {
    store.notify('请先在阵位中编队', 'warn')
    return
  }
  const res = await store.challengeDungeon(stage.id)
  if (!res) return
  const drop = stage.drop
  if (drop) {
    // 材料副本：产出是堆叠物 → 报「道具名 ×数量」
    const itemName = ITEM_DEFS[drop.itemId].name
    const amount = res.rewards.items?.[drop.itemId] ?? 0
    if (res.win) {
      store.notify(
        res.firstClear
          ? `首次通关 ${stage.name} · ${itemName} ×${amount}`
          : `${stage.name} 胜利 · ${itemName} ×${amount}`,
        'ok',
      )
    } else {
      store.notify(`${stage.name} 挑战失败`, 'warn')
    }
    return
  }
  // ⚠ 遗物副本：产出是**实例**（`rewards.relics` 是遗物定义 id 列表，不是数量）
  //   —— 报件数与名字，别去读 `rewards.items`（那儿是空的）。
  const names = (res.rewards.relics ?? []).map((id) => RELIC_DEFS.get(id)?.name ?? id)
  if (res.win) {
    const detail = names.length > 0 ? names.join('、') : '无产出'
    store.notify(
      res.firstClear ? `首次通关 ${stage.name} · 遗物 ${detail}` : `${stage.name} 胜利 · 遗物 ${detail}`,
      'ok',
    )
    // 仓库件数变了 → 重新拉一次统计（套装进度要跟着变）
    void store.loadRelicStats()
  } else {
    store.notify(`${stage.name} 挑战失败`, 'warn')
  }
}

/** **设为挂机通道**（仅已通关可设；同一通道重复设置 = 无操作，不报错） */
async function setAsIdleChannel(stage: DungeonStageDef) {
  const channelKind = DUNGEON_INDEX.get(stage.variantId)?.kind
  if (!channelKind) {
    store.notify('副本配置异常', 'warn')
    return
  }
  const res = await store.setIdleChannel({ channel: channelKind, dungeonStageId: stage.id })
  if (res) store.notify(`${CHANNEL_LABELS[channelKind]}通道已设为 ${stage.name}`, 'ok')
}
</script>

<template>
  <div class="page">
    <div class="page-title">副本</div>

    <!-- 手动挑战的战斗回放（服务端执行 → 回放一次性回传 → 这里演出来） -->
    <ChallengeReplay />

    <!-- 种类切换 -->
    <div class="tabs">
      <button class="tab-btn" :class="{ on: kind === 'skill' }" data-testid="dungeon-kind-skill" @click="switchKind('skill')">
        技能副本
      </button>
      <button class="tab-btn" :class="{ on: kind === 'enhance' }" data-testid="dungeon-kind-enhance" @click="switchKind('enhance')">
        强化副本
      </button>
      <button class="tab-btn" :class="{ on: kind === 'relic' }" data-testid="dungeon-kind-relic" @click="switchKind('relic')">
        遗物副本
      </button>
    </div>

    <!-- ══════════ 遗物副本（存档 v12）：遗物的唯一来源 ══════════ -->
    <template v-if="kind === 'relic'">
      <!-- 每日额度（遗物挂机通道的防通胀闸门） -->
      <section class="panel">
        <div class="row-between">
          <span class="tiny muted">今日遗物额度</span>
          <b class="tiny" data-testid="relic-daily-quota">剩余 {{ quotaLeft }} 件</b>
        </div>
        <p class="tiny muted" style="margin: 4px 0 0">
          挂机通道每日最多产出 {{ formatNumber(RELIC_DROP.DAILY_CAP) }} 件遗物；<b>手动挑战不受额度限制</b>。
        </p>
      </section>

      <!-- 稀有度概率公示（唯一一份口径：core 的 relicDropRates） -->
      <section class="panel">
        <div class="panel-title">
          <span>稀有度概率</span>
          <span class="tiny muted">公示 = 实际</span>
        </div>
        <div
          v-for="difficulty in DUNGEON_DIFFICULTY_ORDER"
          :key="difficulty"
          class="rate-block"
          :data-testid="`relic-rates-${difficulty}`"
        >
          <div class="tiny muted" style="margin-bottom: 2px">{{ difficultyName(difficulty) }}</div>
          <div
            v-for="r in ratesOf(difficulty)"
            :key="r.rarity"
            class="row-between tiny rate-row"
            :data-testid="`relic-rate-${difficulty}-${r.rarity}`"
          >
            <span>{{ r.rarity }}</span>
            <span>{{ percentText(r.percent) }}</span>
          </div>
        </div>
        <p class="tiny muted" style="margin: 6px 0 0">
          连续 {{ RELIC_DROP.PITY_SSR }} 件未出 SSR 时，下一件必出 SSR（保底按「件」计）。
        </p>
      </section>

      <!-- 按副本分组：每个副本覆盖 2 个套装 × 3 个难度 -->
      <section
        v-for="variant in relicVariants"
        :key="variant.id"
        class="panel variant-panel"
        :class="{ hl: focusVariant === variant.id }"
        :data-variant="variant.id"
      >
        <div class="panel-title">
          <span>{{ variant.name }}</span>
          <!-- ⚠ 解锁线文案取配置（`variant.unlockHint`），不就地写中文名 -->
          <span class="tiny muted">{{ variant.unlockHint }}</span>
        </div>

        <!-- 套装进度（这个副本覆盖哪两套，各有几件） -->
        <div
          v-for="setId in variant.relicSetIds ?? []"
          :key="setId"
          class="row-between tiny set-progress"
          :data-testid="`relic-set-progress-${setId}`"
        >
          <span>{{ RELIC_SETS.get(setId)?.name ?? setId }}</span>
          <span class="muted">{{ setCountOf(setId) }} / {{ setTotalOf(setId) }} 件</span>
        </div>

        <!-- 三个难度段 -->
        <div
          v-for="stage in dungeonStagesOfVariant(variant.id)"
          :key="stage.id"
          class="dgn-row"
          :data-testid="`dungeon-stage-${stage.id}`"
        >
          <div class="row-between">
            <b class="tiny">{{ stage.name }}</b>
            <span class="tag" :class="isCleared(stage) ? 'tag-sr' : ''">
              {{ isCleared(stage) ? '已通关' : '未通关' }}
            </span>
          </div>

          <div class="tiny muted" style="margin-top: 3px">
            门槛 {{ formatPower(stage.powerRequired) }} · 缩放 ×{{ stage.enemyScale.toFixed(2) }}
          </div>

          <div class="row-between tiny" style="margin-top: 3px">
            <span class="muted">产出遗物实例</span>
            <span class="muted">每胜 {{ relicCountText(stage.difficulty) }} 件</span>
          </div>

          <!-- 保底进度（按件计；计数随存档落盘，刷新页面不会重置） -->
          <div class="tiny muted" style="margin-top: 3px" :data-testid="`relic-pity-${stage.id}`">
            保底 {{ pityOf(stage) }}/{{ RELIC_DROP.PITY_SSR }} · 再 {{ pityRemain(stage) }} 件必出 SSR
          </div>

          <p v-if="!unlockOf(stage).unlocked" class="tiny warn-text" style="margin: 4px 0 0">
            {{ unlockOf(stage).reason }}
            <!-- ⚠ 遗物副本按**主线进度**解锁 → 被挡住时给一条出路（否则是死路提示）。
                 ⚠ 按钮**只挂一处**（第一个被挡住的关卡），否则同一个 testid 会命中 18 个元素。 -->
            <button
              v-if="firstBlockedRelicStageId === stage.id"
              class="btn btn-sm btn-ghost"
              style="margin-left: 6px"
              data-testid="dungeon-go-expedition"
              @click="router.push('/expedition')"
            >
              去推征
            </button>
          </p>

          <div class="row" style="gap: 6px; margin-top: 6px">
            <button
              class="btn btn-sm btn-primary"
              style="flex: 1"
              :data-testid="`dungeon-challenge-${stage.id}`"
              :disabled="!unlockOf(stage).unlocked"
              @click="challenge(stage)"
            >
              {{ isCleared(stage) ? '再次挑战' : '挑战' }}
            </button>
            <button
              class="btn btn-sm btn-ghost"
              style="flex: 1"
              :data-testid="`dungeon-set-channel-${stage.id}`"
              :disabled="!isCleared(stage)"
              @click="setAsIdleChannel(stage)"
            >
              {{ isIdleTarget(stage) ? '已挂机' : '设为挂机通道' }}
            </button>
          </div>
        </div>
      </section>
    </template>

    <!-- ══════════ 材料副本（技能 / 强化） ══════════ -->
    <template v-else>
      <p class="tiny muted" style="margin: 0 0 10px">
        共 {{ stages.length }} 个独立关卡（难度段 × 变体）。打赢一次即通关；已通关的关卡才能设为挂机通道。
      </p>

      <!-- 按难度段展示 -->
      <section v-for="g in groups" :key="g.difficulty" class="panel">
        <div class="panel-title">
          <span>{{ g.name }}</span>
          <span class="tiny muted">{{ g.stages.length }} 关</span>
        </div>

        <div
          v-for="stage in g.stages"
          :key="stage.id"
          class="dgn-row"
          :class="{ hl: focusVariant === stage.variantId }"
          :data-variant="stage.variantId"
          :data-testid="`dungeon-stage-${stage.id}`"
        >
          <div class="row-between">
            <b class="tiny">{{ stage.name }}</b>
            <span class="tag" :class="isCleared(stage) ? 'tag-sr' : ''">
              {{ isCleared(stage) ? '已通关' : '未通关' }}
            </span>
          </div>

          <div class="tiny muted" style="margin-top: 3px">
            门槛 {{ formatPower(stage.powerRequired) }} · 缩放 ×{{ stage.enemyScale.toFixed(2) }}
          </div>

          <!-- ⚠ `stage.drop` 对遗物副本为 null；材料副本这一段才有道具图标与持有量 -->
          <div v-if="stage.drop" class="row-between tiny" style="margin-top: 3px">
            <span class="muted res-label">
              <img
                class="item-icon-sm"
                :src="resourceIconPath(ITEM_DEFS[stage.drop.itemId].iconKey)"
                :alt="ITEM_DEFS[stage.drop.itemId].name"
                width="16"
                height="16"
              />
              {{ ITEM_DEFS[stage.drop.itemId].name }}
            </span>
            <span class="muted">每胜 {{ stage.drop.min === stage.drop.max ? stage.drop.min : `${stage.drop.min}~${stage.drop.max}` }}</span>
          </div>

          <div v-if="stage.drop" class="tiny muted" style="margin-top: 3px">
            持有 {{ formatNumber(store.save.items[stage.drop.itemId] ?? 0) }}
          </div>

          <p v-if="!unlockOf(stage).unlocked" class="tiny warn-text" style="margin: 4px 0 0">
            {{ unlockOf(stage).reason }}
            <!-- ⚠ 强化副本被遗物解锁线挡住时，当场给一条出路（否则是死路提示）。
                 ⚠ 按钮**只挂一处**（第一个被挡住的强化关卡），否则同一个 testid 会命中 9 个元素。 -->
            <button
              v-if="isEnhanceStage(stage) && firstBlockedEnhanceStageId === stage.id"
              class="btn btn-sm btn-ghost"
              style="margin-left: 6px"
              data-testid="dungeon-go-relic-dungeon"
              @click="goRelicDungeon"
            >
              去遗物副本
            </button>
          </p>

          <div class="row" style="gap: 6px; margin-top: 6px">
            <button
              class="btn btn-sm btn-primary"
              style="flex: 1"
              :data-testid="`dungeon-challenge-${stage.id}`"
              :disabled="!unlockOf(stage).unlocked"
              @click="challenge(stage)"
            >
              {{ isCleared(stage) ? '再次挑战' : '挑战' }}
            </button>
            <button
              class="btn btn-sm btn-ghost"
              style="flex: 1"
              :data-testid="`dungeon-set-channel-${stage.id}`"
              :disabled="!isCleared(stage)"
              @click="setAsIdleChannel(stage)"
            >
              {{ isIdleTarget(stage) ? '已挂机' : '设为挂机通道' }}
            </button>
          </div>
        </div>
      </section>
    </template>

    <!-- 说明 -->
    <section class="panel">
      <div class="panel-title"><span>规则</span></div>
      <ul class="rules">
        <li>副本胜利<b>只</b>发该副本的产出：技能副本发五行材料、强化副本发强化石、<b>遗物副本发遗物实例</b>。</li>
        <li>副本进度与主线记录<b>分开记账</b>，不会推进主线首通。</li>
        <li>技能 / 强化 / 遗物三条副本通道<b>各自独立</b>计量，可与主线同时挂机。</li>
        <li>只有<b>已通关</b>的关卡才能设为挂机通道（挂机永不卡关）。</li>
        <li>遗物副本按<b>主线通关关卡</b>解锁；遗物挂机通道另有每日额度，手动挑战不受限。</li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
}

.tab-btn {
  flex: 1;
  padding: 8px 12px;
  border-radius: 999px;
  border: 1px solid var(--c-line);
  background: var(--c-bg-2);
  color: var(--c-text-dim);
  font-size: 13px;
  min-height: 34px;
}

.tab-btn.on {
  border-color: var(--c-gold);
  color: var(--c-gold-2);
  background: #2a2419;
}

.dgn-row {
  margin-top: 8px;
  padding: 9px 10px;
  border-radius: 8px;
  background: var(--c-bg-2);
  border: 1px solid var(--c-line);
}

/* 深链命中的变体（背包页「去副本」跳过来时标出来） */
.dgn-row.hl {
  border-color: var(--c-gold);
  box-shadow: 0 0 0 1px var(--c-gold) inset;
}

/* 遗物副本的变体卡（按副本分组，套装进度挂在里面） */
.variant-panel.hl {
  border-color: var(--c-gold);
  box-shadow: 0 0 0 1px var(--c-gold) inset;
}

.set-progress {
  padding: 3px 0;
  border-bottom: 1px solid var(--c-line);
}

/* 概率公示：每个难度一块 */
.rate-block {
  margin-top: 6px;
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--c-bg-2);
  border: 1px solid var(--c-line);
}

.rate-row {
  padding: 1px 0;
}

.item-icon-sm {
  width: 16px;
  height: 16px;
  border-radius: 3px;
  object-fit: cover;
  vertical-align: -3px;
  margin-right: 3px;
}

.rules {
  margin: 0;
  padding-left: 18px;
  color: var(--c-text-dim);
  font-size: 12px;
  line-height: 1.7;
}

.warn-text {
  color: #e0a06a;
}
</style>
