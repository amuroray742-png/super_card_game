<script setup lang="ts">
/**
 * 推征（L1 主循环页）：**一屏**跑完「看当前关卡 → 挑战 → 领挂机」。
 *
 * ## 为什么是「一屏」
 *
 * 旧版是 7 块纵向堆叠（主线面板 / 四张通道卡 / 副本入口 / 31 格关卡网格 /
 * 编队概览），实测约 1490px —— 而 360×640 机型的可视内容区只有 534px，
 * 于是「全部领取」这个每日高频按钮落在**第 2 屏中部**。
 *
 * 现在（L1 一屏化）：
 * 1. **主卡**：当前章节 / 关卡名 / 队伍战力 / 战力条 / 「挑战此关」；
 * 2. **挂机卡**：四通道压成**一行一条**的摘要 + 「全部领取（N 次）」+ 遗物额度；
 * 3. **副本入口行**：三枚 chip。
 *
 * 低频信息全部下沉到**带返回按钮的二级页**（页面深度 ≤ 3 级）：
 * - 本章关卡网格 → `/stages`（新增二级页）；
 * - 通道明细（每次产出 / 未开启原因）→ **底部抽屉**（不跳页、不加深度）；
 * - 副本关卡 → `/dungeon?kind=…`（既有二级页）；
 * - 编队 → 底栏「阵位」（既有标签页）。
 *
 * ⚠ **表现层不自推导战斗事实 / 掉落口径 / 通道状态**：一律取 core 与服务端回包。
 * ⚠ 「可结算 N 次」一律取**服务端口径** `store.idlePending`（铁律 #62：
 *   界面写的次数只能少写，绝不能多写）。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useGameStore } from '../stores/game'
import { TEAM_SIZE } from '../../core/systems/team.ts'
import { type DungeonKind } from '../../core/config/dungeons.ts'
import { relicQuotaLeft } from '../../core/systems/relic.ts'
import { formatNumber, formatPower } from '../utils/format'
import { rewardLines } from '../utils/reward-text'
import { dungeonIdleTargetName, mainIdleTargetName } from '../utils/idle-target'
import StageDetailModal from '../components/StageDetailModal.vue'
import type { IdleChannelKind } from '../../core/model/types.ts'

const store = useGameStore()
const router = useRouter()

/** 关卡详情弹窗（就地打开，URL 不变） */
const detailStageId = ref<number | null>(null)

/** 挂机通道明细抽屉是否打开 */
const idleSheet = ref(false)

const stage = computed(() => store.nextChallengeStage)
const chapter = computed(() => stage.value.chapter)
const stageName = computed(() => stage.value.name)

/** 队伍人数（槽位总数取 core 的 `TEAM_SIZE`，不写死 6） */
const teamCount = computed(() => store.team.length)

const powerGap = computed(() => {
  const need = stage.value.powerRequired
  const have = store.teamPower
  // 未编队时战力为 0，不能做除法（会得到 Infinity）
  if (have <= 0) return { need, have, ratio: 0, enough: false, empty: true }
  return { need, have, ratio: have / Math.max(1, need), enough: have >= need, empty: false }
})

// ─────────────────────────── 四通道挂机 ───────────────────────────

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

/**
 * **今日剩余遗物额度**（件）。
 *
 * ⚠ 走 core 的 `relicQuotaLeft`（**唯一一份**，按 UTC 日期键判定）；
 *   时间取**注入时钟** `store.now()`，禁止 `Date.now()`（铁律 #12）。
 * ⚠ 额度只管**挂机**：手动挑战遗物副本不受限（界面必须写清楚，
 *   否则玩家会以为「额度用尽 = 遗物彻底拿不到」）。
 */
const relicQuotaLeftNow = computed(() => relicQuotaLeft(store.save, store.now()))

/** 四张通道卡（次数取**服务端口径**：心跳回执的 `idlePending`） */
const channels = computed<ChannelCard[]>(() => {
  const main = store.save.idle.channels.main
  const skill = store.save.idle.channels.skill
  const enhance = store.save.idle.channels.enhance
  const relic = store.save.idle.channels.relic
  const skillName = dungeonIdleTargetName(store.save, 'skill')
  const enhanceName = dungeonIdleTargetName(store.save, 'enhance')
  const relicName = dungeonIdleTargetName(store.save, 'relic')
  return [
    {
      kind: 'main',
      name: '主线',
      targetName: mainIdleTargetName(store.save, store.clearedStage),
      rolls: store.idlePending.main,
      perRoll: '经验书 / 银两',
      hint: store.clearedStage <= 0 ? '首次手动通关后开始计量' : null,
      enabled: main.target !== null,
    },
    {
      kind: 'skill',
      name: '技能副本',
      targetName: skillName,
      rolls: store.idlePending.skill,
      perRoll: '对应五行的技能材料',
      hint: skillName ? null : '通关一个技能副本关卡后即可开启',
      enabled: skill.target !== null,
    },
    {
      kind: 'enhance',
      name: '强化副本',
      targetName: enhanceName,
      rolls: store.idlePending.enhance,
      perRoll: '对应档位的强化石',
      hint: enhanceName ? null : '通关一个强化副本关卡后即可开启',
      enabled: enhance.target !== null,
    },
    {
      kind: 'relic',
      name: '遗物副本',
      targetName: relicName,
      rolls: store.idlePending.relic,
      perRoll: '遗物实例',
      hint: relicName ? null : '通关一个遗物副本关卡后即可开启',
      enabled: relic.target !== null,
    },
  ]
})

/** 全部可结算次数（四通道相加） */
const totalRolls = computed(() => channels.value.reduce((sum, c) => sum + c.rolls, 0))

/** 通道名（结算明细用；**唯一一份**，四处各写一套必然对不上） */
const CHANNEL_LABELS: Record<IdleChannelKind, string> = {
  main: '主线',
  skill: '技能副本',
  enhance: '强化副本',
  relic: '遗物副本',
}

/**
 * **一键领取**（四通道同时结算）。
 *
 * ⚠ 动作层只有 `idle.tick`（**一次结算全部通道**），没有「单通道领取」这个动作——
 *   所以遗物通道上的「可领 N 次」按钮调的是同一个 `tickIdle`：
 *   按钮上写的 N 是**遗物通道自己**的待结算次数（服务端口径），
 *   实发只会**不少于**它（铁律 #62：界面只能少写，不能多写）。
 */
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
    const label = CHANNEL_LABELS[ch.channel]
    const lines = rewardLines(ch.rewards).map((l) => `${l.label} ${formatNumber(l.value)}`)
    parts.push(`${label} ${ch.rolls} 次：${lines.join('、') || '无产出'}`)
  }
  store.notify(parts.join(' · ') || '挂机结算完成', 'ok')
}

/** 跳到某个副本种类的 tab */
function gotoDungeon(kind: DungeonKind) {
  void router.push({ path: '/dungeon', query: { kind } })
}

/**
 * **去设置某条挂机通道的目标**。
 *
 * ⚠ 主线通道的目标是**主线关卡** ⇒ 走二级页的选关模式（`/stages?pick=main`）；
 *   三个副本通道的目标是**副本关卡** ⇒ 直接跳副本页对应 tab
 *   （副本页每关已有「设为挂机通道」按钮）。
 */
function gotoChannel(kind: IdleChannelKind) {
  idleSheet.value = false
  if (kind === 'main') {
    void router.push({ path: '/stages', query: { pick: 'main' } })
    return
  }
  gotoDungeon(kind === 'skill' ? 'skill' : kind === 'enhance' ? 'enhance' : 'relic')
}

/** 跳到关卡一览（二级页） */
function goStages() {
  void router.push('/stages')
}

// ─────────────────────────── 手动挑战 ───────────────────────────

/**
 * **手动挑战下一关**（主线推进的唯一路径）。
 *
 * ⚠ 战斗在服务端执行（core 同一份），回放一次性回传（不进幂等日志）。
 */
async function challenge() {
  if (store.teamEmpty) {
    // ⚠ 未编队不是「死路」：按钮直接把人送到阵位页（铁律 #27：入口必须够得着）
    store.notify('请先在阵位中编队', 'warn')
    void router.push('/formation')
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
</script>

<template>
  <div class="page">
    <!-- ① 主卡：当前关卡 -->
    <section class="panel">
      <div class="row-between">
        <span class="tiny muted">第 {{ chapter }} 章 · 第 {{ stage.index }} 关</span>
        <button class="btn btn-sm btn-ghost" data-testid="stage-stage-list" @click="goStages">关卡 ›</button>
      </div>

      <!-- 关卡名本身就是「看详情」的入口（就地开弹窗，URL 不变） -->
      <button class="stage-name" data-testid="stage-detail-open" @click="detailStageId = stage.id">
        {{ stageName }}
      </button>

      <div class="row-between tiny" style="margin-top: 6px">
        <span class="muted">队伍 {{ teamCount }}/{{ TEAM_SIZE }}</span>
        <span>
          <span class="muted">战力 </span>
          <b>{{ formatPower(powerGap.have) }}</b>
          <span class="muted"> / {{ formatPower(powerGap.need) }}</span>
        </span>
      </div>
      <div class="bar" style="margin: 5px 0 6px">
        <i :style="{ width: `${Math.min(100, powerGap.ratio * 100)}%` }"></i>
      </div>
      <div class="tiny" :class="powerGap.enough ? 'ok-text' : 'warn-text'">
        {{
          powerGap.empty
            ? '尚未编队，无法推征'
            : powerGap.enough
              ? '战力充足，可推进'
              : `战力不足，尚需 ×${(1 / powerGap.ratio).toFixed(2)}`
        }}
      </div>

      <button
        class="btn btn-primary btn-block"
        style="margin-top: 10px"
        data-testid="campaign-challenge"
        :disabled="store.offline"
        @click="challenge"
      >
        {{ store.teamEmpty ? '先在阵位编队' : '挑战此关' }}
      </button>
    </section>

    <!-- ② 挂机卡：四通道摘要 + 领取 -->
    <section class="panel">
      <div class="panel-title">
        <span>挂机</span>
        <button class="btn btn-sm btn-ghost" data-testid="idle-detail-open" @click="idleSheet = true">
          详情 ›
        </button>
      </div>

      <button
        v-for="ch in channels"
        :key="ch.kind"
        class="chan-row"
        :data-testid="`idle-channel-${ch.kind}`"
        :data-enabled="ch.enabled ? 'true' : 'false'"
        @click="gotoChannel(ch.kind)"
      >
        <span class="chan-dot" :class="{ on: ch.enabled }"></span>
        <span class="chan-left">
          <b class="tiny">{{ ch.name }}</b>
          <span class="tiny muted">{{ ch.targetName ?? '未设置目标' }}</span>
        </span>
        <span class="chan-right">
          <span class="tag" :class="ch.enabled ? 'tag-sr' : ''">{{ ch.enabled ? '已开启' : '未开启' }}</span>
          <span class="tiny">可结算 {{ ch.rolls }} 次</span>
          <span class="chan-arrow" :data-testid="`idle-channel-${ch.kind}-pick`">›</span>
        </span>
      </button>

      <button
        class="btn btn-primary btn-block"
        style="margin-top: 10px"
        data-testid="idle-claim-all"
        :disabled="store.offline"
        @click="claimAll"
      >
        全部领取（{{ totalRolls }} 次）
      </button>

      <!-- ⚠ 遗物额度必须写清楚：额度用尽 ≠ 目标失效（铁律 #52 / #65） -->
      <div class="tiny muted" style="margin-top: 6px">
        遗物今日额度 {{ relicQuotaLeftNow }} 件 · 手动挑战不受额度限制
      </div>
    </section>

    <!-- ③ 副本入口行（遗物副本是遗物的唯一来源，入口必须显式存在） -->
    <div class="chip-row">
      <button class="chip" style="flex: 1" data-testid="dungeon-entry-skill" @click="gotoDungeon('skill')">
        技能副本
      </button>
      <button class="chip" style="flex: 1" data-testid="dungeon-entry-enhance" @click="gotoDungeon('enhance')">
        强化副本
      </button>
      <button class="chip" style="flex: 1" data-testid="dungeon-entry-relic" @click="gotoDungeon('relic')">
        遗物副本
      </button>
    </div>

    <!-- 挂机通道明细（底部抽屉：不跳页、不加页面深度） -->
    <div v-if="idleSheet" class="sheet-mask" @click.self="idleSheet = false">
      <div class="sheet" data-testid="idle-detail">
        <div class="panel-title">
          <span>挂机通道</span>
          <button class="btn btn-sm btn-ghost" data-testid="idle-detail-close" @click="idleSheet = false">关闭</button>
        </div>

        <div
          v-for="ch in channels"
          :key="ch.kind"
          class="chan-detail"
          :data-testid="`idle-detail-${ch.kind}`"
        >
          <div class="row-between">
            <b class="tiny">{{ ch.name }}</b>
            <span class="tag" :class="ch.enabled ? 'tag-sr' : ''">{{ ch.enabled ? '已开启' : '未开启' }}</span>
          </div>
          <div class="tiny" style="margin-top: 4px">{{ ch.targetName ?? '未设置目标' }}</div>
          <div class="tiny muted" style="margin-top: 2px">
            可结算 {{ ch.rolls }} 次 · 每次产出 {{ ch.perRoll }}
          </div>
          <div v-if="ch.kind === 'relic'" class="tiny muted" style="margin-top: 2px">
            今日剩余额度 {{ relicQuotaLeftNow }} 件 · 手动挑战不受额度限制
          </div>
          <div v-if="ch.hint" class="tiny warn-text" style="margin-top: 2px">{{ ch.hint }}</div>
          <button
            class="btn btn-sm btn-ghost btn-block"
            style="margin-top: 6px"
            :data-testid="`idle-detail-${ch.kind}-pick`"
            @click="gotoChannel(ch.kind)"
          >
            {{ ch.enabled ? '更换目标' : '去设置' }}
          </button>
        </div>

        <p class="tiny muted" style="margin: 8px 0 0">
          挂机<b>不跑战斗</b>：按掉落表逐次掷奖直接入库，只挂已通关的内容，永不卡关。
        </p>
      </div>
    </div>

    <!-- 关卡详情弹窗 -->
    <StageDetailModal v-if="detailStageId !== null" :stage-id="detailStageId" @close="detailStageId = null" />
  </div>
</template>

<style scoped>
/** 关卡名：做成「看起来像标题、按下去开详情」的按钮 */
.stage-name {
  display: block;
  width: 100%;
  margin-top: 2px;
  text-align: left;
  font-size: 17px;
  font-weight: 700;
  line-height: 1.35;
  color: var(--c-text);
}

.ok-text {
  color: var(--c-green);
}

.warn-text {
  color: #e0a06a;
}

.chan-detail {
  margin-top: 8px;
  padding: 9px 10px;
  border-radius: 8px;
  background: var(--c-bg-2);
  border: 1px solid var(--c-line);
}
</style>
