<script setup lang="ts">
/**
 * 战斗回放渲染器（Canvas 2D · §6.3「数值型轻演出」）。
 *
 * 只负责「把 core 产出的事件流画出来」，不做任何规则计算——
 * 战斗结果完全由 core/systems/battle.ts 决定，渲染层不参与判定。
 *
 * ⚠ 画面是**时间的纯函数**：所有状态都由 `battle-timeline.ts` 按时刻 t 推导，
 *   不做增量累积。因此倍速只是时间缩放、跳回合直接设 t、重播清零，
 *   不会出现「快进后血条对不上」。
 *
 * ⚠ 站位 / 出场回合 / 职业 / 五行 / 是否 BOSS 全部来自 core 的名册，
 *   表现层不得自行推导（AGENTS.md 铁律 #8 / #16）。
 */
import { ref, watch, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import type { BattleResult, BattleUnitRosterEntry } from '../../core/model/types.ts'
import { portraitPath, enemyArtPath, AVATAR_CROP } from '../../core/config/art.ts'
import {
  buildTimeline,
  projectState,
  collectEffects,
  tweenedHp,
  type BattleTimeline,
  type BattleEffect,
  type BattleState,
} from '../utils/battle-timeline.ts'

const props = defineProps<{
  battle: BattleResult | null
  /** 播放倍速（1 / 2 / 4 / 8） */
  speed?: number
  /** 当前章节（决定战场氛围色，1 起） */
  chapter?: number
  /** 「跳过演出」：开启时直接出结算 */
  skipAnim?: boolean
}>()

const emit = defineEmits<{
  /** 演出播完（或被跳过） */
  (e: 'finished'): void
  /** 玩家改了倍速（由页面写回存档 settings.speed） */
  (e: 'speed-change', value: number): void
}>()

const canvas = ref<HTMLCanvasElement | null>(null)
const ctx = ref<CanvasRenderingContext2D | null>(null)
const playing = ref(false)
const timeMs = ref(0)
const timeline = ref<BattleTimeline | null>(null)
/** 最近一次绘制时的战场状态（供 DOM 侧断言用，避免测试里重算一遍） */
const lastState = ref<BattleState | null>(null)

/** 倍速档位（与 BATTLE.SPEED_OPTIONS 一致） */
const SPEEDS = [1, 2, 4, 8] as const

const speed = computed(() => props.speed ?? 1)

// ─────────────────────────── 布局与配色 ───────────────────────────

/** 头像半径 */
const UNIT_R = 21
/** 名牌相对头像的纵向偏移 */
const NAME_DY = -32
/** 血条相对头像的纵向偏移 */
const BAR_DY = 30
/** 血条宽度 */
const BAR_W = 48
/**
 * 飘字基线相对头像的纵向偏移与上浮距离。
 *
 * ⚠ 上浮必须**留出画布顶部空间**：第一排单位在 `h × 0.34`，
 *   若飘字从 `y - 44` 往上飘 30px，末排飘字会整个飞出画布（只见数字下半截）。
 */
const FLOAT_DY = -48
const FLOAT_RISE = 18
/** 飘字基线的最低位置（不出画布顶） */
const FLOAT_MIN_Y = 11

/** 定位色标（沿用全局主题板，不另造花哨配色） */
const ROLE_COLOR: Record<string, string> = {
  猛将: '#c0392b',
  统帅: '#c8a951',
  谋士: '#4e8fa8',
  医者: '#52be80',
  器者: '#9fc6f0',
}

/** 五行色（对应 global.css 的 --e-*） */
const ELEMENT_COLOR: Record<string, string> = {
  金: '#d4b96a',
  木: '#6f9e5e',
  土: '#b08d57',
  水: '#5b9bc0',
  火: '#d9603b',
}

/** 各章战场氛围渐变（低饱和暗色，只做氛围，不画具体场景） */
const CHAPTER_BG: [string, string][] = [
  ['#1b1a16', '#121110'],
  ['#241d16', '#14100c'],
  ['#14212a', '#0d1418'],
  ['#1c1b2e', '#101020'],
  ['#16241a', '#0d1410'],
  ['#2a1710', '#160c09'],
  ['#18232b', '#0d1216'],
  ['#1e1a2b', '#12101a'],
  ['#101826', '#080d14'],
  ['#221a2e', '#120e1a'],
]

// ─────────────────────────── 立绘缓存 ───────────────────────────

/** 立绘图片缓存（模块级：换战斗不必重新下载） */
const imageCache = new Map<string, HTMLImageElement>()

function loadImage(src: string): HTMLImageElement | null {
  const cached = imageCache.get(src)
  if (cached) return cached.complete && cached.naturalWidth > 0 ? cached : null
  const img = new Image()
  img.onload = () => draw()
  img.src = src
  imageCache.set(src, img)
  return null
}

/** 单位立绘路径：英灵走卡面，敌人走占位头像（约定都在 core/config/art.ts） */
function artOf(unit: BattleUnitRosterEntry): string {
  return unit.side === 'ally' ? portraitPath(unit.defId) : enemyArtPath(unit.defId)
}

// ─────────────────────────── 画布尺寸 ───────────────────────────

/**
 * 同步画布尺寸与设备像素比。
 *
 * ⚠ 顺序不能反：给 `el.width` / `el.height` 赋值会**重置 2D 上下文的变换矩阵**，
 * 所以 `setTransform` 必须在尺寸赋值**之后**、且 `ctx` 已拿到时执行。
 * 历史教训：原先 `onMounted` 里先调 `resize()`（此时 `ctx.value` 还是 null，
 * 变换没设上）才赋值 ctx → 高分屏上整个战斗场景被画进 2x 缓冲的左上角，
 * 整场战斗缩成一半大小挤在角落。
 */
function resize() {
  const el = canvas.value
  if (!el) return
  const c = ctx.value ?? el.getContext('2d')
  if (!c) return
  ctx.value = c
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const rect = el.getBoundingClientRect()
  el.width = Math.max(1, Math.floor(rect.width * dpr))
  el.height = Math.max(1, Math.floor(rect.height * dpr))
  // 尺寸赋值会重置变换，必须重新设置
  c.setTransform(dpr, 0, 0, dpr, 0, 0)
}

// ─────────────────────────── 站位 ───────────────────────────

/**
 * 单位站位：每侧 3 行纵列 × 2 列纵深，**前排朝敌、后排在后**。
 *
 * ⚠ 必须用**真实编队槽位号**（core 名册给的 `slot`）：队伍会跳过空槽位，
 * 用「队伍里第几个」会把后排的人画到前排去（AGENTS.md 铁律 #16）。
 */
function positionOf(unit: BattleUnitRosterEntry): { x: number; y: number } {
  const w = canvas.value?.clientWidth ?? 360
  const h = canvas.value?.clientHeight ?? 240
  const row = unit.slot % 3
  const col = Math.floor(unit.slot / 3) // 0=前排 1=后排
  const x = unit.side === 'ally' ? w * 0.3 - col * w * 0.17 : w * 0.7 + col * w * 0.17
  const y = h * 0.34 + row * h * 0.19
  return { x, y }
}

// ─────────────────────────── 绘制 ───────────────────────────

function draw() {
  const c = ctx.value
  const el = canvas.value
  const tl = timeline.value
  if (!c || !el || !tl) return
  const w = el.clientWidth
  const h = el.clientHeight
  const t = timeMs.value

  c.clearRect(0, 0, w, h)

  // 背景：章节氛围渐变 + 地面分割 + 中央界线
  const bg = CHAPTER_BG[Math.min(CHAPTER_BG.length, Math.max(1, props.chapter ?? 1)) - 1]
  const grad = c.createLinearGradient(0, 0, 0, h)
  grad.addColorStop(0, bg[0])
  grad.addColorStop(1, bg[1])
  c.fillStyle = grad
  c.fillRect(0, 0, w, h)

  c.strokeStyle = 'rgba(200,169,81,0.18)'
  c.lineWidth = 1
  c.beginPath()
  c.moveTo(w / 2, 0)
  c.lineTo(w / 2, h)
  c.stroke()

  const state = projectState(tl, t)
  const effects = collectEffects(tl, t)
  lastState.value = state

  // 单位
  for (const unit of tl.roster) {
    const us = state.units[unit.id]
    if (!us || !us.visible) continue
    const { x, y } = positionOf(unit)
    const alive = us.alive
    const isBoss = !!unit.mechanic
    const radius = UNIT_R

    // 本单位身上的瞬时效果
    const flash = effects.find((e) => e.kind === 'flash' && e.targetId === unit.id)
    const hit = effects.find((e) => e.kind === 'hit' && e.targetId === unit.id)
    const death = effects.find((e) => e.kind === 'death' && e.targetId === unit.id)
    const summon = effects.find((e) => e.kind === 'summon' && e.targetId === unit.id)

    // 死亡淡出 / 入场缩放
    let alpha = 1
    let scale = 1
    if (death) {
      alpha = 1 - death.progress * 0.65
      scale = 1 - death.progress * 0.12
    }
    if (summon) scale = 0.55 + summon.progress * 0.45
    if (flash) scale *= 1 + Math.sin(flash.progress * Math.PI) * 0.14

    // 站位光圈（扁平一点，别被血条切掉一半）
    c.beginPath()
    c.ellipse(x, y + 29, 24, 7, 0, 0, Math.PI * 2)
    c.fillStyle = unit.side === 'ally' ? 'rgba(200,169,81,0.16)' : 'rgba(192,57,43,0.16)'
    c.fill()

    const r = radius * scale

    // 头像（圆形裁剪 + 立绘）
    c.save()
    c.globalAlpha = alpha
    c.beginPath()
    c.arc(x, y, r, 0, Math.PI * 2)
    c.clip()
    const img = loadImage(artOf(unit))
    if (img) {
      const crop = unit.side === 'ally' ? AVATAR_CROP.hero : AVATAR_CROP.enemy
      const nw = img.naturalWidth
      const nh = img.naturalHeight
      const side = nw * crop.sizeRatio
      c.drawImage(img, (nw - side) / 2, nh * crop.topRatio, side, side, x - r, y - r, r * 2, r * 2)
    } else {
      // 未就绪：元素色圆盘占位
      c.fillStyle = ELEMENT_COLOR[unit.element] ?? '#3a362d'
      c.fillRect(x - r, y - r, r * 2, r * 2)
    }
    // 阵亡：压灰
    if (!alive) {
      c.fillStyle = 'rgba(20,18,16,0.72)'
      c.fillRect(x - r, y - r, r * 2, r * 2)
    }
    c.restore()

    // 定位色环
    c.beginPath()
    c.arc(x, y, r + 2, 0, Math.PI * 2)
    c.strokeStyle = alive ? (ROLE_COLOR[unit.role] ?? '#8a8272') : '#3a362d'
    c.lineWidth = 2
    c.stroke()

    // BOSS 额外描边（金色双环）
    if (isBoss && alive) {
      c.beginPath()
      c.arc(x, y, r + 6, 0, Math.PI * 2)
      c.strokeStyle = 'rgba(200,169,81,0.75)'
      c.lineWidth = 1.5
      c.stroke()
    }

    // 技能闪光：白色脉冲环
    if (flash) {
      c.beginPath()
      c.arc(x, y, r + 4 + flash.progress * 12, 0, Math.PI * 2)
      c.strokeStyle = `rgba(255,255,255,${(1 - flash.progress) * 0.8})`
      c.lineWidth = 2
      c.stroke()
    }

    // 受击红闪
    if (hit) {
      c.beginPath()
      c.arc(x, y, r, 0, Math.PI * 2)
      c.fillStyle = `rgba(192,57,43,${(1 - hit.progress) * 0.45})`
      c.fill()
    }

    // 五行色点
    c.beginPath()
    c.arc(x - r + 4, y + r - 4, 3.5, 0, Math.PI * 2)
    c.fillStyle = ELEMENT_COLOR[unit.element] ?? '#8a8272'
    c.fill()

    // 名牌
    c.fillStyle = alive ? 'rgba(236,229,214,0.9)' : 'rgba(120,112,99,0.6)'
    c.font = isBoss ? 'bold 11px sans-serif' : '11px sans-serif'
    c.textAlign = 'center'
    c.fillText(unit.name, x, y + NAME_DY)

    // 血条（补间平滑）
    const hp = Math.max(0, tweenedHp(us, t))
    const ratio = us.maxHp > 0 ? Math.max(0, Math.min(1, hp / us.maxHp)) : 0
    const bx = x - BAR_W / 2
    const by = y + BAR_DY
    c.fillStyle = '#151310'
    c.fillRect(bx, by, BAR_W, 5)
    c.fillStyle = ratio > 0.5 ? '#52be80' : ratio > 0.25 ? '#c8a951' : '#c0392b'
    c.fillRect(bx, by, BAR_W * ratio, 5)
    // BOSS 血条分段（每 10% 一刻度）
    if (isBoss) {
      c.strokeStyle = 'rgba(20,18,16,0.85)'
      c.lineWidth = 1
      for (let i = 1; i < 10; i++) {
        const sx = bx + (BAR_W * i) / 10
        c.beginPath()
        c.moveTo(sx, by)
        c.lineTo(sx, by + 5)
        c.stroke()
      }
      c.strokeStyle = 'rgba(200,169,81,0.8)'
      c.lineWidth = 1
      c.strokeRect(bx - 0.5, by - 0.5, BAR_W + 1, 6)
    }
  }

  // 飘字
  drawFloats(c, effects)

  // 最新一条事件文字
  const idx = state.eventIndex
  const log = tl.events[Math.max(0, idx - 1)]?.entry
  if (log) {
    c.fillStyle = 'rgba(0,0,0,0.45)'
    c.fillRect(0, h - 30, w, 30)
    c.fillStyle = '#ece5d6'
    c.font = '12px sans-serif'
    c.textAlign = 'center'
    c.fillText(log.text, w / 2, h - 11)
  }
}

/** 飘字：伤害 / 暴击 / 治疗 / 护盾 / 吸收 */
function drawFloats(c: CanvasRenderingContext2D, effects: BattleEffect[]) {
  let slot = 0
  for (const e of effects) {
    if (!e.kind.startsWith('float-')) continue
    const unit = timeline.value?.roster.find((u) => u.id === e.targetId)
    if (!unit) continue
    const { x, y } = positionOf(unit)
    const p = e.progress
    const alpha = 1 - p * p
    const offset = (slot % 4) * 9
    slot++

    let color = '#ece5d6'
    let text = String(Math.round(e.value))
    let size = 14
    if (e.kind === 'float-crit') {
      color = '#e8c87a'
      size = 19
      text = `暴击 ${Math.round(e.value)}`
    } else if (e.kind === 'float-damage') {
      color = '#f0e6d2'
    } else if (e.kind === 'float-heal') {
      color = '#52be80'
      text = `+${Math.round(e.value)}`
    } else if (e.kind === 'float-shield') {
      color = '#5b9bc0'
      text = `盾 ${Math.round(e.value)}`
    } else if (e.kind === 'float-absorb') {
      color = '#8a8272'
      text = `吸收 ${Math.round(e.value)}`
    }

    c.save()
    c.globalAlpha = alpha
    c.fillStyle = color
    c.font = `bold ${size}px sans-serif`
    c.textAlign = 'center'
    c.strokeStyle = 'rgba(0,0,0,0.75)'
    c.lineWidth = 3
    // 上浮但**不出画布顶**：第一排单位上方的空间有限，硬飘会整段飞出画布
    const fy = Math.max(FLOAT_MIN_Y, y + FLOAT_DY - p * FLOAT_RISE)
    c.strokeText(text, x + offset, fy)
    c.fillText(text, x + offset, fy)
    c.restore()
  }
}

// ─────────────────────────── 播放控制 ───────────────────────────

let raf = 0
let lastTs = 0

function step(ts: number) {
  raf = requestAnimationFrame(step)
  if (!playing.value || !timeline.value) return
  if (!lastTs) lastTs = ts
  const dt = ts - lastTs
  lastTs = ts
  const total = timeline.value.duration
  timeMs.value = Math.min(total, timeMs.value + dt * speed.value)
  if (timeMs.value >= total) {
    playing.value = false
    emit('finished')
  }
  draw()
}

/**
 * 通知父组件「演出结束」。
 *
 * 首次 `loadBattle()` 发生在 setup 期间（父组件正在渲染），
 * 此时**同步 emit 会让父组件在渲染中被改状态**——推迟到下一个 tick 再报。
 */
function emitFinished() {
  nextTick(() => emit('finished'))
}

/** 重建时间轴并回到开头 */
function loadBattle() {
  const b = props.battle
  if (!b) {
    timeline.value = null
    timeMs.value = 0
    return
  }
  timeline.value = buildTimeline(b.log, b.roster)
  timeMs.value = 0
  playing.value = false
  lastTs = 0
  // 「跳过演出」：直接出结算
  if (props.skipAnim) {
    timeMs.value = timeline.value.duration
    draw()
    emitFinished()
    return
  }
  // 新战斗**自动开演**——观战与战斗预览都靠这一句起播，
  // 否则页面还得手动调 replay()，而关卡详情页根本没人调（预览会卡在第 0 帧不动）。
  playing.value = true
  draw()
}

function replay() {
  if (!timeline.value) return
  // 「跳过演出」开启时不重播，直接给结果
  if (props.skipAnim) {
    timeMs.value = timeline.value.duration
    playing.value = false
    draw()
    emitFinished()
    return
  }
  timeMs.value = 0
  playing.value = true
  lastTs = 0
  draw()
}

function pause() {
  playing.value = false
  draw()
}

function skipToEnd() {
  if (!timeline.value) return
  timeMs.value = timeline.value.duration
  playing.value = false
  draw()
  emitFinished()
}

/** 跳到指定回合的起点 */
function seekToRound(round: number) {
  const tl = timeline.value
  if (!tl) return
  const anchor = tl.rounds.find((r) => r.round === round)
  if (!anchor) return
  timeMs.value = anchor.at
  draw()
}

/** 点击进度条：吸附到最近的回合起点 */
function onTrackClick(ev: MouseEvent) {
  const tl = timeline.value
  const el = canvas.value?.parentElement?.querySelector('.track') as HTMLElement | null
  if (!tl || !el || tl.duration <= 0) return
  const rect = el.getBoundingClientRect()
  const ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width))
  const target = ratio * tl.duration
  let best = tl.rounds[0]
  for (const r of tl.rounds) {
    if (Math.abs(r.at - target) < Math.abs(best.at - target)) best = r
  }
  timeMs.value = best?.at ?? 0
  draw()
}

function setSpeed(v: number) {
  emit('speed-change', v)
}

const progressRatio = computed(() => {
  const tl = timeline.value
  if (!tl || tl.duration <= 0) return 0
  return Math.max(0, Math.min(1, timeMs.value / tl.duration))
})

const currentRound = computed(() => {
  const tl = timeline.value
  if (!tl) return 0
  let round = 0
  for (const r of tl.rounds) {
    if (r.at <= timeMs.value) round = r.round
  }
  return round
})

const totalRounds = computed(() => timeline.value?.rounds.length ?? 0)

/**
 * 当前在场的单位数（援军未入场不计入）。
 *
 * 只作 DOM 侧断言用——端到端用例据此判断「画面上真的有人」，
 * 表现层不因此做任何额外判定。
 */
const visibleUnits = computed(() => {
  const st = lastState.value
  if (!st) return 0
  return Object.values(st.units).filter((u) => u.visible).length
})

defineExpose({ replay, skipToEnd })

watch(
  () => props.battle,
  () => loadBattle(),
  { immediate: true },
)

watch(
  () => props.skipAnim,
  (v) => {
    if (v && timeline.value) {
      timeMs.value = timeline.value.duration
      playing.value = false
      draw()
      emitFinished()
    }
  },
)

onMounted(() => {
  // ⚠ 顺序：先拿 ctx，再 resize（resize 会按 DPR 设置变换矩阵），最后重绘
  ctx.value = canvas.value?.getContext('2d') ?? null
  resize()
  draw()
  raf = requestAnimationFrame(step)
  window.addEventListener('resize', handleResize)
})

/** 窗口尺寸变化：改画布尺寸会清空画布，必须重绘 */
function handleResize() {
  resize()
  draw()
}

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  window.removeEventListener('resize', handleResize)
})
</script>

<template>
  <div class="battle-box">
    <canvas
      ref="canvas"
      class="battle-canvas"
      :data-round="currentRound"
      :data-total-rounds="totalRounds"
      :data-progress="progressRatio.toFixed(4)"
      :data-duration="timeline?.duration ?? 0"
      :data-visible-units="visibleUnits"
      :data-speed="speed"
    ></canvas>

    <!-- 回合进度条：按回合分段，可点击跳到该回合起点 -->
    <div v-if="battle" class="track" @click="onTrackClick">
      <div class="track-fill" :style="{ width: `${progressRatio * 100}%` }"></div>
      <div
        v-for="r in timeline?.rounds ?? []"
        :key="r.round"
        class="track-tick"
        :style="{ left: `${(r.at / (timeline?.duration || 1)) * 100}%` }"
      ></div>
    </div>

    <div class="battle-ctrl">
      <button class="btn btn-sm" :disabled="!battle" @click="playing ? pause() : replay()">
        {{ playing ? '暂停' : '播放' }}
      </button>
      <button class="btn btn-sm" :disabled="!battle" @click="replay">重播</button>
      <button class="btn btn-sm" :disabled="!battle" @click="skipToEnd">跳过</button>
      <div class="speeds">
        <button
          v-for="v in SPEEDS"
          :key="v"
          class="chip tiny"
          :class="{ on: speed === v }"
          @click="setSpeed(v)"
        >
          ×{{ v }}
        </button>
      </div>
      <span v-if="battle" class="tiny muted">
        第 {{ currentRound }} / {{ totalRounds }} 回合
      </span>
    </div>
  </div>
</template>

<style scoped>
.battle-box {
  border: 1px solid var(--c-line);
  border-radius: 10px;
  overflow: hidden;
  background: #121110;
}

.battle-canvas {
  display: block;
  width: 100%;
  height: 240px;
}

/* 回合进度条 */
.track {
  position: relative;
  height: 6px;
  background: #1c1915;
  cursor: pointer;
}

.track-fill {
  position: absolute;
  inset: 0 auto 0 0;
  background: linear-gradient(90deg, rgba(200, 169, 81, 0.55), rgba(200, 169, 81, 0.9));
}

.track-tick {
  position: absolute;
  top: 0;
  width: 1px;
  height: 6px;
  background: rgba(236, 229, 214, 0.28);
  transform: translateX(-0.5px);
}

.battle-ctrl {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border-top: 1px solid var(--c-line);
  background: var(--c-panel);
}

.speeds {
  display: flex;
  gap: 4px;
}

.chip.tiny {
  padding: 2px 7px;
  font-size: 11px;
}
</style>
