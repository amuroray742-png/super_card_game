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
const units = ref<Record<string, { name: string; side: 'ally' | 'enemy'; hp: number; maxHp: number }>>({})

let raf = 0
let lastTs = 0
let acc = 0

const FRAME_MS = 320

function resize() {
  const el = canvas.value
  if (!el) return
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const rect = el.getBoundingClientRect()
  el.width = Math.max(1, Math.floor(rect.width * dpr))
  el.height = Math.max(1, Math.floor(rect.height * dpr))
  const c = ctx.value
  if (c) c.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function slotOf(id: string): { side: 'ally' | 'enemy'; idx: number } {
  const u = units.value[id]
  const idx = Math.max(0, Object.keys(units.value).indexOf(id))
  return { side: u?.side ?? 'ally', idx }
}

/** 单位站位：左侧 3 个前排 + 3 个后排，右侧镜像 */
function positionOf(id: string): { x: number; y: number } {
  const { side, idx } = slotOf(id)
  const w = canvas.value?.clientWidth ?? 360
  const h = canvas.value?.clientHeight ?? 220
  const row = idx % 3
  const col = Math.floor(idx / 3) // 0=前排 1=后排
  const x = side === 'ally' ? w * 0.16 + col * w * 0.1 : w * 0.84 - col * w * 0.1
  const y = h * 0.34 + row * h * 0.2
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
  if (kind === 'damage' || kind === 'dot') {
    const t = units.value[entry.targetId]
    if (t) t.hp = Math.max(0, t.hp - entry.amount)
  } else if (kind === 'heal') {
    const t = units.value[entry.targetId]
    if (t) t.hp = Math.min(t.maxHp, t.hp + entry.amount)
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
  for (const u of Object.values(units.value)) u.hp = u.maxHp
  logIndex.value = 0
  playing.value = true
  lastTs = 0
}

function skipToEnd() {
  if (!props.battle) return
  for (const entry of props.battle.log) applyLog(entry)
  logIndex.value = props.battle.log.length
  playing.value = false
  draw()
}

/** 由父组件注入参战单位信息 */
function setUnits(list: Record<string, { name: string; side: 'ally' | 'enemy'; hp: number; maxHp: number }>) {
  units.value = list
  draw()
}

defineExpose({ replay, skipToEnd, setUnits })

watch(
  () => props.battle,
  (b) => {
    if (b) {
      logIndex.value = 0
      playing.value = false
      draw()
    }
  },
)

onMounted(() => {
  resize()
  ctx.value = canvas.value?.getContext('2d') ?? null
  draw()
  raf = requestAnimationFrame(step)
  window.addEventListener('resize', resize)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  window.removeEventListener('resize', resize)
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
