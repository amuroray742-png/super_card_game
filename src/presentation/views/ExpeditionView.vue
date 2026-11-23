<script setup lang="ts">
/**
 * 推征（首页）：**主线手动挑战 + 三通道挂机 + 副本入口**（挂机改版 v11）。
 *
 * ## 结构（自上而下）
 *
 * 1. **主线面板**：当前章节 / 关卡名 / 战力对比 / 「挑战此关」+「详情」。
 * 2. **三通道挂机面板**：三张卡（主线 / 技能副本 / 强化副本），
 *    各显示目标、可结算次数与每次产出；**只有一个「全部领取」入口**。
 * 3. **副本入口卡**：「技能副本」「强化副本」→ `/dungeon?kind=…`。
 * 4. **本章关卡网格**：点击 → 开关卡详情**弹窗**（URL 不变）。
 * 5. **编队概览**。
 *
 * ⚠ **表现层不自推导战斗事实 / 掉落口径 / 通道状态**：一律取 core 与服务端回包。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useGameStore } from '../stores/game'
import { STAGES } from '../../core/config/stages.ts'
import { DROP_TABLES } from '../../core/config/economy.ts'
import {
  DUNGEON_INDEX,
  DUNGEON_STAGE_INDEX,
  dungeonStagesOf,
  type DungeonKind,
} from '../../core/config/dungeons.ts'
import { idleChannelRolls } from '../../core/systems/idle.ts'
import { formatNumber, formatPower } from '../utils/format'
import { rewardLines } from '../utils/reward-text'
import StageDetailModal from '../components/StageDetailModal.vue'
import ChallengeReplay from '../components/ChallengeReplay.vue'
import type { IdleChannelKind } from '../../core/model/types.ts'

const store = useGameStore()
const router = useRouter()

/** 关卡详情弹窗（就地打开，URL 不变） */
const detailStageId = ref<number | null>(null)

const stage = computed(() => store.nextChallengeStage)
const chapter = computed(() => Math.ceil(stage.value.id / 31))
const stageName = computed(() => stage.value.name)

/** 当前关卡的掉落表（战后结算展示） */
const drops = computed(() => DROP_TABLES[stage.value.dropTableId])

const powerGap = computed(() => {
  const need = stage.value.powerRequired
  const have = store.teamPower
  // 未编队时战力为 0，不能做除法（会得到 Infinity）
  if (have <= 0) return { need, have, ratio: 0, enough: false, empty: true }
  return { need, have, ratio: have / Math.max(1, need), enough: have >= need, empty: false }
})

/** 当前章节的关卡列表 */
const chapterStages = computed(() => STAGES.filter((s) => s.chapter === chapter.value))

// ─────────────────────────── 三通道挂机 ───────────────────────────

interface ChannelCard {
  kind: IdleChannelKind
  /** 通道名 */
  name: string
  /** 目标显示名（`null` = 未设置） */
  targetName: string | null
  /** 可结算次数 */
  rolls: number
  /** 每次产出说明 */
  perRoll: string
  /** 未启用 / 目标失效时的提示 */
  hint: string | null
  /** 是否已启用 */
  enabled: boolean
}

/** 主线通道的目标名（跟随最新通关关卡） */
function mainTargetName(): string | null {
  const t = store.save.idle.channels.main.target
  if (!t || t.kind !== 'main') return null
  if (t.stageId === null) {
    if (store.clearedStage <= 0) return null
    const s = STAGES.find((x) => x.id === store.clearedStage)
    return s ? `${s.name}（跟随最新）` : null
  }
  const s = STAGES.find((x) => x.id === t.stageId)
  return s ? s.name : null
}

/** 副本通道的目标名 */
function dungeonTargetName(kind: IdleChannelKind): string | null {
  const t = store.save.idle.channels[kind].target
  if (!t) return null
  const id = t.kind === 'skill' || t.kind === 'enhance' ? t.dungeonStageId : null
  if (!id) return null
  return DUNGEON_STAGE_INDEX.get(id)?.name ?? null
}

/** 三张通道卡（口径与 core 同一份换算） */
const channels = computed<ChannelCard[]>(() => {
  const main = store.save.idle.channels.main
  const skill = store.save.idle.channels.skill
  const enhance = store.save.idle.channels.enhance
  const skillName = dungeonTargetName('skill')
  const enhanceName = dungeonTargetName('enhance')
  return [
    {
      kind: 'main',
      name: '主线',
      targetName: mainTargetName(),
      rolls: idleChannelRolls(main),
      perRoll: '经验书 / 银两',
      hint: store.clearedStage <= 0 ? '首次手动通关后开始计量' : null,
      enabled: main.target !== null,
    },
    {
      kind: 'skill',
      name: '技能副本',
      targetName: skillName,
      rolls: idleChannelRolls(skill),
      perRoll: '对应五行的技能材料',
      hint: skillName ? null : '通关一个技能副本关卡后即可开启',
      enabled: skill.target !== null,
    },
    {
      kind: 'enhance',
      name: '强化副本',
      targetName: enhanceName,
      rolls: idleChannelRolls(enhance),
      perRoll: '对应档位的强化石',
      hint: enhanceName ? null : '通关一个强化副本关卡后即可开启',
      enabled: enhance.target !== null,
    },
  ]
})

/** 全部可结算次数（三通道相加） */
const totalRolls = computed(() => channels.value.reduce((sum, c) => sum + c.rolls, 0))

/** **一键领取**（三通道同时结算） */
async function claimAll() {
  const res = await store.tickIdle()
  if (!res) return
  if (res.rolls === 0) {
    store.notify('当前可用的挂机时间尚不足一次结算', 'info')
    return
  }
  // ⚠ 结算明细的名称一律取登记表（铁律 #8：禁止就地写中文名）
  const parts: string[] = []
  for (const ch of res.channels) {
    const label = ch.channel === 'main' ? '主线' : ch.channel === 'skill' ? '技能副本' : '强化副本'
    const lines = rewardLines(ch.rewards).map((l) => `${l.label} ${formatNumber(l.value)}`)
    parts.push(`${label} ${ch.rolls} 次：${lines.join('、') || '无产出'}`)
  }
  store.notify(parts.join(' · ') || '挂机结算完成', 'ok')
}

/** 跳到某个副本种类的 tab */
function gotoDungeon(kind: DungeonKind) {
  void router.push({ path: '/dungeon', query: { kind } })
}

// ─────────────────────────── 手动挑战 ───────────────────────────

/**
 * **手动挑战下一关**（主线推进的唯一路径）。
 *
 * ⚠ 战斗在服务端执行（core 同一份），回放一次性回传（不进幂等日志）。
 */
async function challenge() {
  if (store.teamEmpty) {
    store.notify('请先在阵位中编队', 'warn')
    return
  }
  const res = await store.challengeStage()
  if (!res) return
  if (res.win) {
    store.notify(res.firstClear ? `首次通关 ${stage.value.name}` : `${stage.value.name} 胜利`, 'ok')
  } else {
    store.notify(`${stage.value.name} 挑战失败`, 'warn')
  }
}

/** **再次挑战**已通关的关卡（复战只发基础掉落，不推进进度） */
async function challengeStageCurrent() {
  if (store.teamEmpty) {
    store.notify('请先在阵位中编队', 'warn')
    return
  }
  if (store.clearedStage <= 0) {
    store.notify('还没有通关任何关卡，先挑战第 1 关', 'info')
    return
  }
  const res = await store.challengeStage(store.clearedStage)
  if (!res) return
  store.notify(res.win ? '再次挑战胜利' : '再次挑战失败', res.win ? 'ok' : 'warn')
}
</script>

<template>
  <div class="page">
    <div class="page-title">推征</div>

    <!-- 手动挑战的战斗回放（服务端执行 → 回放一次性回传 → 这里演出来） -->
    <ChallengeReplay />

    <!-- 主线面板 -->
    <section class="panel">
      <div class="row-between">
        <div>
          <div class="tiny muted">第 {{ chapter }} 章 · 第 {{ stage.index }} 关</div>
          <div style="font-size: 17px; font-weight: 700; margin-top: 2px">{{ stageName }}</div>
        </div>
        <button class="btn btn-sm btn-ghost" data-testid="stage-detail-open" @click="detailStageId = stage.id">
          详情 ›
        </button>
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
              : powerGap.enough
                ? '战力充足，可推进'
                : `战力不足，尚需 ×${(1 / powerGap.ratio).toFixed(2)}`
          }}
        </div>
      </div>

      <div class="row" style="margin-top: 12px; gap: 6px">
        <button class="btn btn-sm btn-primary" style="flex: 1" data-testid="campaign-challenge" @click="challenge">
          挑战此关
        </button>
        <button class="btn btn-sm" style="flex: 1" @click="challengeStageCurrent">再次挑战上一关</button>
      </div>
    </section>

    <!-- 三通道挂机面板 -->
    <section class="panel">
      <div class="panel-title">
        <span>挂机通道</span>
        <span class="tiny muted">三条通道各自独立计量</span>
      </div>

      <div v-for="ch in channels" :key="ch.kind" class="chan-card" :data-testid="`idle-channel-${ch.kind}`">
        <div class="row-between">
          <b class="tiny">{{ ch.name }}</b>
          <span class="tag" :class="ch.enabled ? 'tag-sr' : ''">{{ ch.enabled ? '已开启' : '未开启' }}</span>
        </div>
        <div class="tiny" style="margin-top: 4px">
          <template v-if="ch.targetName">{{ ch.targetName }}</template>
          <template v-else><span class="muted">未设置目标</span></template>
        </div>
        <div class="tiny muted" style="margin-top: 2px">
          可结算 {{ ch.rolls }} 次 · 每次产出 {{ ch.perRoll }}
        </div>
        <div v-if="ch.hint" class="tiny warn-text" style="margin-top: 2px">{{ ch.hint }}</div>
        <div class="row" style="gap: 6px; margin-top: 6px">
          <button
            v-if="ch.kind === 'main'"
            class="btn btn-sm btn-ghost"
            style="flex: 1"
            data-testid="idle-channel-main-pick"
            @click="detailStageId = store.clearedStage > 0 ? store.clearedStage : 1"
          >
            更换目标
          </button>
          <button
            v-else
            class="btn btn-sm btn-ghost"
            style="flex: 1"
            :data-testid="`idle-channel-${ch.kind}-pick`"
            @click="gotoDungeon(ch.kind === 'skill' ? 'skill' : 'enhance')"
          >
            去设置
          </button>
        </div>
      </div>

      <button class="btn btn-primary btn-block" style="margin-top: 10px" data-testid="idle-claim-all" @click="claimAll">
        全部领取（{{ totalRolls }} 次）
      </button>
      <p class="tiny muted" style="margin: 6px 0 0">
        挂机<b>不跑战斗</b>：按掉落表逐次掷奖直接入库，只挂已通关的内容，永不卡关。
      </p>
    </section>

    <!-- 副本入口卡 -->
    <section class="panel">
      <div class="panel-title"><span>副本</span></div>
      <div class="row" style="gap: 6px">
        <button class="btn btn-sm entry-card" style="flex: 1" data-testid="dungeon-entry-skill" @click="gotoDungeon('skill')">
          <b>技能副本</b>
          <span class="tiny muted">五行技能材料</span>
        </button>
        <button class="btn btn-sm entry-card" style="flex: 1" data-testid="dungeon-entry-enhance" @click="gotoDungeon('enhance')">
          <b>强化副本</b>
          <span class="tiny muted">三档强化石</span>
        </button>
      </div>
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
          :data-testid="`stage-cell-${s.id}`"
          @click="detailStageId = s.id"
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

    <!-- 关卡详情弹窗 -->
    <StageDetailModal v-if="detailStageId !== null" :stage-id="detailStageId" @close="detailStageId = null" />
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

.chan-card {
  margin-top: 8px;
  padding: 9px 10px;
  border-radius: 8px;
  background: var(--c-bg-2);
  border: 1px solid var(--c-line);
}

.entry-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 10px;
  text-align: left;
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
