<script setup lang="ts">
/**
 * 材料副本（技能副本 / 强化副本）——**24 个独立关卡**（挂机改版 v11）。
 *
 * ## 副本是独立关卡
 *
 * `(变体 × 难度) = 1 关`，共 5 技能变体 × 3 难度 + 3 强化变体 × 3 难度 = **24 关**。
 * 每关有自己的敌人组合、缩放锚点、战力门槛与产量，**打赢一次即通关**。
 * 不再借用主线波次（设计稿 D9 / F14）。
 *
 * ## 挂机
 *
 * 副本是**两条挂机通道之一**（技能 / 强化），与主线**各自独立**计量。
 * 只有**已通关**的副本关卡才能设为挂机目标（挂机只挂已通关内容）。
 *
 * ⚠ **规则一律取 core**（铁律 #2 / #4）：
 *   - 关卡定义 → `core/config/dungeons.ts`；
 *   - 解锁判定 → `core/systems/dungeons.ts` 的 `dungeonUnlocked`。
 */
import { computed, nextTick, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useGameStore } from '../stores/game'
import {
  DUNGEON_DIFFICULTY_ORDER,
  DUNGEON_INDEX,
  DUNGEON_VARIANT_ORDER,
  dungeonStagesOf,
  findDungeonVariant,
  type DungeonKind,
  type DungeonStageDef,
} from '../../core/config/dungeons.ts'
import { DUNGEON_DIFFICULTIES, type RelicStoneTierId } from '../../core/config/economy.ts'
import type { Element } from '../../core/model/types.ts'
import { dungeonStageUnlocked } from '../../core/systems/dungeons.ts'
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

/** 副本种类（tab） */
const kind = computed<DungeonKind>(() => (queryValue('kind') === 'enhance' ? 'enhance' : 'skill'))

/**
 * **深链指定的变体**（背包页「去副本」会带 `?element=…` / `?tier=…`）。
 *
 * ⚠ 解析走 core 的 `findDungeonVariant`（唯一出处，铁律 #3 / #8）——
 *   表现层不得自己拼变体 id。
 *
 * 命中时该变体的关卡**高亮并滚到视野内**：点「去副本」要真的看到对应关卡，
 * 否则「入口可达」只是 URL 变了（铁律 #27 的反面）。
 */
const focusVariant = computed(() => {
  const variant = findDungeonVariant(
    kind.value,
    queryValue('element') as Element | undefined,
    queryValue('tier') as RelicStoneTierId | undefined,
  )
  return variant?.id ?? null
})

/** 当前种类下的全部关卡（按难度段 × 变体排列） */
const stages = computed(() => dungeonStagesOf(kind.value))

/** 按难度段分组（简易 / 普通 / 困难） */
const groups = computed(() =>
  DUNGEON_DIFFICULTY_ORDER.map((difficulty) => ({
    difficulty,
    name: DUNGEON_DIFFICULTIES.find((d) => d.id === difficulty)?.name ?? difficulty,
    stages: stages.value.filter((s) => s.difficulty === difficulty),
  })),
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

/** 某条通道当前挂的是不是这一关 */
function isIdleTarget(stage: DungeonStageDef): boolean {
  const t = store.save.idle.channels[stage.variantId.startsWith('skill') ? 'skill' : 'enhance'].target
  if (!t) return false
  return (t.kind === 'skill' || t.kind === 'enhance') && t.dungeonStageId === stage.id
}

/**
 * 进页面先拉一次仓库统计。
 *
 * ⚠ 强化副本的解锁线要「仓库里的最高等级」，而客户端镜像里只有已装备遗物 →
 *   这份统计只能问服务端（`GET /api/relics/stats`）。
 */
onMounted(() => {
  void store.loadRelicStats()
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
  const itemName = ITEM_DEFS[stage.drop.itemId].name
  if (res.win) {
    const amount = res.rewards.items?.[stage.drop.itemId] ?? 0
    store.notify(
      res.firstClear ? `首次通关 ${stage.name} · ${itemName} ×${amount}` : `${stage.name} 胜利 · ${itemName} ×${amount}`,
      'ok',
    )
  } else {
    store.notify(`${stage.name} 挑战失败`, 'warn')
  }
}

/** **设为挂机通道**（仅已通关可设；同一通道重复设置 = 无操作，不报错） */
async function setAsIdleChannel(stage: DungeonStageDef) {
  const channel = stage.variantId.startsWith('skill') ? 'skill' : 'enhance'
  const res = await store.setIdleChannel({ channel, dungeonStageId: stage.id })
  if (res) store.notify(`${channel === 'skill' ? '技能' : '强化'}通道已设为 ${stage.name}`, 'ok')
}
</script>

<template>
  <div class="page">
    <div class="page-title">材料副本</div>

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
    </div>

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

        <div class="row-between tiny" style="margin-top: 3px">
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

        <div class="tiny muted" style="margin-top: 3px">
          持有 {{ formatNumber(store.save.items[stage.drop.itemId] ?? 0) }}
        </div>

        <p v-if="!unlockOf(stage).unlocked" class="tiny warn-text" style="margin: 4px 0 0">
          {{ unlockOf(stage).reason }}
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

    <!-- 说明 -->
    <section class="panel">
      <div class="panel-title"><span>规则</span></div>
      <ul class="rules">
        <li>副本胜利<b>只</b>发所选的五行材料或石档，不发银两、经验书、遗物。</li>
        <li>副本进度与主线记录<b>分开记账</b>，不会推进主线首通。</li>
        <li>技能通道与强化通道<b>各自独立</b>计量，可与主线同时挂机。</li>
        <li>只有<b>已通关</b>的关卡才能设为挂机通道（挂机永不卡关）。</li>
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
