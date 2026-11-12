<script setup lang="ts">
/**
 * 战斗回放渲染器（Canvas 2D）。
 *
 * 只负责「把 BattleResult 的日志流画出来」，不做任何规则计算——
 * 战斗结果完全由 core/systems/battle.ts 决定，渲染层不参与判定。
 */
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import type { BattleResult } from '../../core/model/types.ts'

const props = defineProps<{
  battle: BattleResult | null
  speed?: number
}>()

const canvas = ref<HTMLCanvasElement | null>(null)
const ctx = ref<CanvasRenderingContext2D | null>(null)
const playing = ref(false)
const logIndex = ref(0)

/** 参与战斗的单位：id → 展示信息 */
interface CanvasUnit {
  name: string
  side: 'ally' | 'enemy'
  hp: number
  maxHp: number
  slot: number
  /** 出场回合（1 起）。召唤援军 > 1，出场前不画。 */
  appearRound: number
  /** 尚未出场（召唤援军出场前） */
  hidden: boolean
}

const units = ref<Record<string, CanvasUnit>>({})

/** 当前回合：由日志推进。用于判断援军是否已出场。 */
const currentRound = ref(1)

let raf = 0
let lastTs = 0
let acc = 0

const FRAME_MS = 320

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

/**
 * 由战斗结果的名册初始化单位。
 *
 * ⚠ 单位 id / 槽位 / 初始血量**全部来自 core 的 `roster`**，
 * 表现层不得自行拼接（AGENTS.md 铁律 #8）：
 * 自行拼 id 会与日志里的 actorId / targetId 对不上，血条就永远不变。
 *
 * 召唤援军（appearRound > 1）初始为「未出场」，等日志里的 summon 事件再亮出来。
 */
function initUnits() {
  const map: Record<string, CanvasUnit> = {}
  for (const u of props.battle?.roster ?? []) {
    map[u.id] = {
      name: u.name,
      side: u.side,
      hp: u.maxHp,
      maxHp: u.maxHp,
      slot: u.slot,
      appearRound: u.appearRound,
      hidden: u.appearRound > 1,
    }
  }
  units.value = map
  currentRound.value = 1
}

/**
 * 单位站位：每侧 3 行纵列 × 2 列纵深，**前排朝敌、后排在后**。
 *
 * 槽位约定：
 * - 我方 0-2 = 前排（近战位），3-5 = 后排（远程位）
 * - 敌方 = 该阵营内的出场序号（0 起）
 *
 *   - 纵向 row = slot % 3（同一纵列里三个位从上到下）
 *   - 纵深 col = floor(slot / 3)：0 = 前排，1 = 后排
 *
 * 敌人在右侧（x 更大），所以我方**前排取更大的 x**（靠近敌人）、
 * 后排取更小的 x；敌方镜像（col 0 取更小的 x，靠近我方）。
 *
 * ⚠ 必须用**真实编队槽位号**：队伍会跳过空槽位，
 * 用「队伍里第几个」会把后排的人画到前排去。
 */
function positionOf(id: string): { x: number; y: number } {
  const u = units.value[id]
  const side = u?.side ?? 'ally'
  const slot = u?.slot ?? 0
  const w = canvas.value?.clientWidth ?? 360
  const h = canvas.value?.clientHeight ?? 220
  const row = slot % 3
  const col = Math.floor(slot / 3) // 0=前排 1=后排
  // 前排与后排的横向间距要大于单位直径（半径 20 → 直径 40），否则两列会重叠
  const x = side === 'ally' ? w * 0.32 - col * w * 0.18 : w * 0.68 + col * w * 0.18
  const y = h * 0.32 + row * h * 0.2
  return { x, y }
}

function draw() {
  const c = ctx.value
  const el = canvas.value
  if (!c || !el) return
  const w = el.clientWidth
  const h = el.clientHeight

  c.clearRect(0, 0, w, h)

  // 背景：地面分割 + 中央界线
  const grad = c.createLinearGradient(0, 0, 0, h)
  grad.addColorStop(0, '#1b1a16')
  grad.addColorStop(1, '#121110')
  c.fillStyle = grad
  c.fillRect(0, 0, w, h)

  c.strokeStyle = 'rgba(200,169,81,0.18)'
  c.lineWidth = 1
  c.beginPath()
  c.moveTo(w / 2, 0)
  c.lineTo(w / 2, h)
  c.stroke()

  // 单位
  for (const [id, u] of Object.entries(units.value)) {
    if (u.hidden) continue
    const { x, y } = positionOf(id)
    const alive = u.hp > 0
    const ratio = u.maxHp > 0 ? Math.max(0, u.hp / u.maxHp) : 0

    // 站位光圈
    c.beginPath()
    c.ellipse(x, y + 26, 26, 9, 0, 0, Math.PI * 2)
    c.fillStyle = u.side === 'ally' ? 'rgba(200,169,81,0.16)' : 'rgba(192,57,43,0.16)'
    c.fill()

    // 身体
    c.beginPath()
    c.arc(x, y, 20, 0, Math.PI * 2)
    c.fillStyle = alive
      ? u.side === 'ally'
        ? '#3a3225'
        : '#3a2520'
      : '#26241f'
    c.fill()
    c.strokeStyle = alive
      ? u.side === 'ally'
        ? '#c8a951'
        : '#a8453a'
      : '#3a362d'
    c.lineWidth = 2
    c.stroke()

    // 名牌
    c.fillStyle = alive ? 'rgba(236,229,214,0.88)' : 'rgba(120,112,99,0.6)'
    c.font = '11px sans-serif'
    c.textAlign = 'center'
    c.fillText(u.name, x, y - 28)

    // 血条
    const bw = 44
    const bh = 4
    c.fillStyle = '#151310'
    c.fillRect(x - bw / 2, y + 34, bw, bh)
    c.fillStyle = ratio > 0.5 ? '#52be80' : ratio > 0.25 ? '#c8a951' : '#c0392b'
    c.fillRect(x - bw / 2, y + 34, bw * ratio, bh)
  }

  // 最新一条日志
  const log = props.battle?.log[logIndex.value - 1]
  if (log) {
    c.fillStyle = 'rgba(0,0,0,0.45)'
    c.fillRect(0, h - 34, w, 34)
    c.fillStyle = '#ece5d6'
    c.font = '12px sans-serif'
    c.textAlign = 'center'
    c.fillText(log.text, w / 2, h - 13)
  }
}

/** 按日志推进血量 */
function applyLog(entry: BattleResult['log'][number]): void {
  const kind = entry.kind
  if (entry.round > currentRound.value) currentRound.value = entry.round
  if (kind === 'damage' || kind === 'dot') {
    const t = units.value[entry.targetId]
    if (t) t.hp = Math.max(0, t.hp - entry.amount)
  } else if (kind === 'heal') {
    const t = units.value[entry.targetId]
    if (t) t.hp = Math.min(t.maxHp, t.hp + entry.amount)
  } else if (kind === 'summon') {
    // 召唤援军入场：由 core 的 roster 决定 id / 槽位 / 初始血量，
    // 这里只负责「让它出现」（AGENTS.md 铁律 #8 / #16）。
    const t = units.value[entry.targetId]
    if (t) t.hidden = false
  }
}

function step(ts: number) {
  raf = requestAnimationFrame(step)
  if (!playing.value || !props.battle) return
  if (!lastTs) lastTs = ts
  const dt = ts - lastTs
  lastTs = ts
  acc += dt * (props.speed ?? 1)
  while (acc >= FRAME_MS && logIndex.value < props.battle.log.length) {
    acc -= FRAME_MS
    const entry = props.battle.log[logIndex.value]
    logIndex.value++
    applyLog(entry)
  }
  if (logIndex.value >= props.battle.log.length) {
    playing.value = false
  }
  draw()
}

function replay() {
  if (!props.battle) return
  initUnits()
  logIndex.value = 0
  playing.value = true
  lastTs = 0
}

function skipToEnd() {
  if (!props.battle) return
  initUnits()
  for (const entry of props.battle.log) applyLog(entry)
  logIndex.value = props.battle.log.length
  playing.value = false
  draw()
}

defineExpose({ replay, skipToEnd })

watch(
  () => props.battle,
  (b) => {
    if (b) {
      initUnits()
      logIndex.value = 0
      playing.value = false
      draw()
    }
  },
  { immediate: true },
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
    <canvas ref="canvas" class="battle-canvas"></canvas>
    <div class="battle-ctrl">
      <button class="btn btn-sm" :disabled="!battle" @click="replay">
        {{ playing ? '重播' : '播放' }}
      </button>
      <button class="btn btn-sm" :disabled="!battle" @click="skipToEnd">跳过</button>
      <span v-if="battle" class="tiny muted">
        第 {{ logIndex }} / {{ battle.log.length }} 条 · {{ battle.win ? '胜' : '败' }}
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
  height: 220px;
}

.battle-ctrl {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-top: 1px solid var(--c-line);
  background: var(--c-panel);
}
</style>
