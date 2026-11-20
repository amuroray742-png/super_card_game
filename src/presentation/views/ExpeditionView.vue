<script setup lang="ts">
/**
 * 推征（首页）：关卡推进 + 挂机 + 战斗回放。
 *
 * ⚠ **挂机去向**（资源/背包版本 v10）：主线 / 技能副本 / 强化副本
 *   共用**同一份时间账本**，切换时服务端先结清旧去向再换新去向（设计稿 §3）。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useGameStore } from '../stores/game'
import { STAGES, STAGE_INDEX } from '../../core/config/stages.ts'
import { getEnemy } from '../../core/config/enemies.ts'
import { DROP_TABLES, RELIC, DUNGEON_DIFFICULTIES, type DungeonDifficultyId, type RelicStoneTierId } from '../../core/config/economy.ts'
import { runBattle } from '../../core/systems/battle.ts'
import { buildPveContext } from '../../core/systems/derive.ts'
import { formatNumber, formatPower } from '../utils/format'
import { rewardLines } from '../utils/reward-text'
import BattleCanvas from '../components/BattleCanvas.vue'
import BattleResultPanel from '../components/BattleResultPanel.vue'
import type { BattleResult, Element } from '../../core/model/types.ts'

const store = useGameStore()
const router = useRouter()

const showCanvas = ref(false)
const showResult = ref(false)
const battle = ref<BattleResult | null>(null)

const stage = computed(() => store.currentStage)
const chapter = computed(() => Math.ceil(stage.value.id / 31))
const stageName = computed(() => stage.value.name)
const farm = computed(() => store.save.idle.farm)
const farmStage = computed(() => STAGE_INDEX.get(farm.value?.stage ?? 0))

/** 当前关卡的掉落表（战后结算展示） */
const drops = computed(() => DROP_TABLES[stage.value.dropTableId])

// ─────────────────────────── 挂机去向 ───────────────────────────

/** 当前挂机去向（服务端权威镜像） */
const idleTarget = computed(() => store.save.idle.target)

/** 去向选择器当前编辑的种类（默认跟存档一致） */
const targetKind = ref<'campaign' | 'skill' | 'enhance'>(idleTarget.value.kind)
const targetElement = ref<Element>(
  idleTarget.value.kind === 'skill' ? idleTarget.value.element : '金',
)
const targetTier = ref<RelicStoneTierId>(
  idleTarget.value.kind === 'enhance' ? idleTarget.value.tier : 'relicStoneTier1',
)
const targetDifficulty = ref<DungeonDifficultyId>(
  idleTarget.value.kind === 'campaign' ? 'easy' : idleTarget.value.difficulty,
)

/** 当前去向下文的显示名 */
const targetName = computed(() => {
  const t = idleTarget.value
  if (t.kind === 'campaign') return '主线'
  if (t.kind === 'skill') return `技能副本 · ${t.element}`
  const tier = RELIC.STONE_TIERS.find((x) => x.id === t.tier)
  return `强化副本 · ${tier?.name ?? t.tier}`
})

/** 切到别的种类时，把难度拉回合法值 */
function pickKind(kind: 'campaign' | 'skill' | 'enhance') {
  targetKind.value = kind
  if (kind === 'campaign') return
  if (!DUNGEON_DIFFICULTIES.some((d) => d.id === targetDifficulty.value)) {
    targetDifficulty.value = 'easy'
  }
}

/** 切换挂机去向（服务端先结清旧去向） */
async function applyTarget() {
  const kind = targetKind.value
  const res = await store.setIdleTarget(
    kind === 'campaign'
      ? { kind: 'campaign', stageId: stage.value.id }
      : kind === 'skill'
        ? { kind: 'skill', element: targetElement.value, difficulty: targetDifficulty.value }
        : { kind: 'enhance', tier: targetTier.value, difficulty: targetDifficulty.value },
  )
  if (res) store.notify('挂机去向已更新', 'ok')
}

/** 副本战败时给出的「降一档难度」建议 */
const dungeonBlocked = ref<{ suggest: DungeonDifficultyId } | null>(null)

/** 按建议降一档难度 */
async function lowerDifficulty() {
  const suggest = dungeonBlocked.value?.suggest
  if (!suggest) return
  targetDifficulty.value = suggest
  const kind = idleTarget.value.kind
  if (kind === 'skill') {
    await store.setIdleTarget({ kind: 'skill', element: idleTarget.value.element, difficulty: suggest })
  } else if (kind === 'enhance') {
    await store.setIdleTarget({ kind: 'enhance', tier: idleTarget.value.tier, difficulty: suggest })
  }
  dungeonBlocked.value = null
}

const powerGap = computed(() => {
  const need = stage.value.powerRequired
  const have = store.teamPower
  // 未编队时战力为 0，不能做除法（会得到 Infinity）
  if (have <= 0) return { need, have, ratio: 0, enough: false, empty: true }
  return { need, have, ratio: have / Math.max(1, need), enough: have >= need, empty: false }
})

/** 当前章节的关卡列表 */
const chapterStages = computed(() => STAGES.filter((s) => s.chapter === chapter.value))

/** 手动打一场并播放回放 */
function fight() {
  if (store.teamEmpty) {
    store.notify('请先在阵位中编队', 'warn')
    return
  }
  const enemyIds = stage.value.enemyIds
  const enemies = enemyIds.map((id) => getEnemy(id)).filter(Boolean)
  if (enemies.length === 0) return
  const result = runBattle({
    allies: store.team,
    enemies,
    enemyScale: stage.value.enemyScale,
    ctx: buildPveContext(store.save, store.nextBattleSeed()),
  })
  battle.value = result
  showCanvas.value = true
  showResult.value = false
  // 画布收到新战斗会自动开演（BattleCanvas 的 loadBattle 负责起播）
}

/** 演出播完（或被跳过）：展示战后结算 */
function onFinished() {
  showResult.value = true
}

/** 回放倍速：写回存档设置（与设置页同一口径） */
function onSpeedChange(v: number) {
  void store.updateSettings({ speed: v })
}

/** 挂机推进 N 场 */
async function idle(battles: number) {
  if (store.teamEmpty) {
    store.notify('请先在阵位中编队', 'warn')
    return
  }
  const res = await store.tickIdle(battles)
  if (res) {
    if (res.battles === 0) {
      store.notify('当前可用的挂机时间尚不足一场', 'info')
      return
    }
    // ⚠ 结算明细的名称一律取登记表（铁律 #8：禁止就地写中文名）
    const parts = rewardLines(res.rewards).map((l) => `${l.label} ${formatNumber(l.value)}`)
    if (res.blockedAtStage !== null) {
      const lost = STAGE_INDEX.get(res.blockedAtStage)?.name
      parts.unshift(`${lost ?? '当前关卡'}战败`)
    }
    // 副本战败：给出「降一档难度」的建议（设计稿 §3）
    const d = res.dungeon
    if (d && d.blockedAtBattle !== null) {
      dungeonBlocked.value = d.suggestDifficulty
        ? { suggest: d.suggestDifficulty as DungeonDifficultyId }
        : null
      parts.unshift(`副本第 ${d.blockedAtBattle} 场战败`)
    }
    store.notify(parts.length ? parts.join(' · ') : '推征完成', res.blockedAtStage !== null ? 'warn' : 'ok')
  }
}
</script>

<template>
  <div class="page">
    <div class="page-title">推征</div>

    <!-- 当前关卡 -->
    <section class="panel">
      <div class="row-between">
        <div>
          <div class="tiny muted">第 {{ chapter }} 章 · 第 {{ stage.index }} 关</div>
          <div style="font-size: 17px; font-weight: 700; margin-top: 2px">{{ stageName }}</div>
        </div>
        <button class="btn btn-sm btn-ghost" @click="router.push(`/stage/${stage.id}`)">详情 ›</button>
      </div>

      <div class="power-box">
        <div class="row-between tiny">
          <span class="muted">编队战力</span>
          <b>{{ formatPower(powerGap.have) }}</b>
        </div>
        <div class="bar" style="margin: 5px 0 8px">
          <i :style="{ width: `${Math.min(100, powerGap.ratio * 100)}%` }"></i>
        </div>
        <div class="row-between tiny">
          <span class="muted">关卡门槛</span>
          <span :class="powerGap.enough ? '' : 'muted'">{{ formatPower(powerGap.need) }}</span>
        </div>
        <div class="tiny" style="margin-top: 6px" :class="powerGap.enough ? 'ok-text' : 'warn-text'">
          {{
            powerGap.empty
              ? '尚未编队，无法推征'
              : farm
                ? '当前挑战受阻'
                : powerGap.enough
                ? '战力充足，可推进'
                : `战力不足，尚需 ×${(1 / powerGap.ratio).toFixed(2)}`
          }}
        </div>
        <div v-if="farm" class="tiny muted" style="margin-top: 6px">
          <template v-if="farmStage && farm.winsUntilRetry > 0">
            正在刷取「{{ farmStage.name }}」，再胜 {{ farm.winsUntilRetry }} 场后重试。
          </template>
          <template v-else-if="farmStage">下次推征将重试当前挑战。</template>
          <template v-else>尚无可刷关卡，可调整阵容后重试。</template>
        </div>
      </div>

      <div class="row" style="margin-top: 12px; gap: 6px">
        <button class="btn btn-sm" style="flex: 1" @click="idle(1)">推征 1 场</button>
        <button class="btn btn-sm" style="flex: 1" @click="idle(10)">推征 10 场</button>
        <button class="btn btn-sm btn-primary" style="flex: 1" @click="fight">观战</button>
      </div>
    </section>

    <!-- 挂机去向 -->
    <section class="panel">
      <div class="row-between">
        <div class="tiny muted">挂机去向</div>
        <b class="tiny" data-testid="idle-target-name">{{ targetName }}</b>
      </div>
      <div class="chips">
        <button
          class="chip"
          :class="{ on: targetKind === 'campaign' }"
          data-testid="idle-target-campaign"
          @click="pickKind('campaign')"
        >
          主线
        </button>
        <button
          class="chip"
          :class="{ on: targetKind === 'skill' }"
          data-testid="idle-target-skill"
          @click="pickKind('skill')"
        >
          技能副本
        </button>
        <button
          class="chip"
          :class="{ on: targetKind === 'enhance' }"
          data-testid="idle-target-enhance"
          @click="pickKind('enhance')"
        >
          强化副本
        </button>
      </div>

      <!-- 技能副本：五行 -->
      <div v-if="targetKind === 'skill'" class="chips">
        <button
          v-for="el in (['金', '木', '水', '火', '土'] as Element[])"
          :key="el"
          class="chip"
          :class="{ on: targetElement === el }"
          :data-testid="`idle-target-element-${el}`"
          @click="targetElement = el"
        >
          {{ el }}
        </button>
      </div>

      <!-- 强化副本：石档 -->
      <div v-if="targetKind === 'enhance'" class="chips">
        <button
          v-for="tier in RELIC.STONE_TIERS"
          :key="tier.id"
          class="chip"
          :class="{ on: targetTier === tier.id }"
          :data-testid="`idle-target-tier-${tier.id}`"
          @click="targetTier = tier.id"
        >
          {{ tier.name }}
        </button>
      </div>

      <!-- 副本难度 -->
      <div v-if="targetKind !== 'campaign'" class="chips">
        <button
          v-for="d in DUNGEON_DIFFICULTIES"
          :key="d.id"
          class="chip"
          :class="{ on: targetDifficulty === d.id }"
          :data-testid="`idle-target-difficulty-${d.id}`"
          @click="targetDifficulty = d.id"
        >
          {{ d.name }}
        </button>
      </div>

      <div class="row" style="gap: 6px; margin-top: 8px">
        <button class="btn btn-sm btn-primary" style="flex: 1" data-testid="idle-target-apply" @click="applyTarget">
          切换去向
        </button>
        <button class="btn btn-sm btn-ghost" style="flex: 1" @click="router.push('/dungeon')">
          材料副本 ›
        </button>
      </div>
      <p class="tiny muted" style="margin: 6px 0 0">
        三个去向共用同一份挂机时间；切换时先按旧去向结清收益，再开始新去向。
      </p>
      <div v-if="dungeonBlocked" class="warn-text" style="margin-top: 6px">
        副本战败：战力不足，建议降到更低难度。
        <button class="btn btn-sm" style="margin-left: 6px" data-testid="idle-lower-difficulty" @click="lowerDifficulty">
          降一档难度
        </button>
      </div>
    </section>

    <!-- 战斗回放 -->
    <section v-if="showCanvas" class="panel">
      <div class="panel-title">
        <span>战斗回放</span>
        <button class="btn btn-sm btn-ghost" @click="showCanvas = false">收起</button>
      </div>
      <BattleCanvas
        :battle="battle"
        :speed="store.battleSpeed"
        :chapter="chapter"
        :skip-anim="store.save.settings.skipAnim"
        @finished="onFinished"
        @speed-change="onSpeedChange"
      />
      <BattleResultPanel v-if="showResult && battle" class="result-wrap" :battle="battle" :drops="drops" />
    </section>

    <!-- 本章关卡 -->
    <section class="panel">
      <div class="panel-title">
        <span>第 {{ chapter }} 章 · 关卡</span>
        <span class="tiny muted">已通关 {{ store.clearedStage }} 关</span>
      </div>
      <div class="stage-grid">
        <button
          v-for="s in chapterStages"
          :key="s.id"
          class="stage-cell"
          :class="{
            done: s.id <= store.clearedStage,
            now: s.id === stage.id,
            boss: s.isBoss,
          }"
          @click="router.push(`/stage/${s.id}`)"
        >
          <span class="s-idx">{{ s.index }}</span>
          <span v-if="s.isBoss" class="s-boss">BOSS</span>
        </button>
      </div>
    </section>

    <!-- 编队概览 -->
    <section class="panel">
      <div class="panel-title">
        <span>当前编队</span>
        <button class="btn btn-sm btn-ghost" @click="router.push('/formation')">调整 ›</button>
      </div>
      <div v-if="store.teamEmpty" class="empty">尚未编队，无法推征</div>
      <div v-else class="team-row">
        <div v-for="hero in store.team" :key="hero.def.id" class="team-chip">
          <img
            :src="hero.def.portrait"
            class="portrait"
            :class="`portrait-${hero.def.rarity.toLowerCase()}`"
            width="44"
            height="44"
            loading="lazy"
          />
          <div class="tiny">
            <div>{{ hero.def.name }}</div>
            <div class="muted">Lv{{ hero.state.level }}</div>
          </div>
        </div>
      </div>
      <div v-if="store.bondStates.length" class="bonds">
        <span v-for="b in store.bondStates.filter((x) => x.active)" :key="b.bond.id" class="tag tag-sr">
          {{ b.bond.name }}
        </span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.power-box {
  margin-top: 12px;
  padding: 10px;
  border-radius: 8px;
  background: var(--c-bg-2);
  border: 1px solid var(--c-line);
}

.result-wrap {
  margin-top: 10px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 8px 0 0;
}

.chip {
  padding: 4px 11px;
  border-radius: 999px;
  border: 1px solid var(--c-line);
  background: var(--c-bg-2);
  font-size: 12px;
  color: var(--c-text-dim);
  min-height: 28px;
}

.chip.on {
  border-color: var(--c-gold);
  color: var(--c-gold-2);
  background: #2a2419;
}

.ok-text {
  color: var(--c-green);
}

.warn-text {
  color: #e0a06a;
}

.stage-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(46px, 1fr));
  gap: 6px;
}

.stage-cell {
  position: relative;
  aspect-ratio: 1;
  border-radius: 8px;
  border: 1px solid var(--c-line);
  background: var(--c-bg-2);
  color: var(--c-text-mute);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
}

.stage-cell.done {
  border-color: #4a5f3f;
  background: #232a1e;
  color: #a9c48c;
}

.stage-cell.now {
  border-color: var(--c-gold);
  color: var(--c-gold-2);
  box-shadow: 0 0 0 1px rgba(200, 169, 81, 0.3) inset;
}

.stage-cell.boss .s-boss {
  position: absolute;
  bottom: 1px;
  font-size: 8px;
  color: #d98a7a;
  letter-spacing: 0.05em;
}

.team-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.team-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px 4px 4px;
  border-radius: 8px;
  background: var(--c-bg-2);
  border: 1px solid var(--c-line);
}

.bonds {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
</style>
