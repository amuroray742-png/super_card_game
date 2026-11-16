<script setup lang="ts">
/**
 * 抽卡演出（蓄力 → 逐张翻牌 → SR 光效 → SSR 全屏爆点）。
 *
 * 铁律 #20：演出是**时间的纯函数 `f(t)`**——
 * 整段演出由 `planReveal()` 排成事件表，画面由 `projectReveal(t)` 推导，
 * 本组件只维护一个时间量 `t`（毫秒），**不做增量累积状态**：
 * - 跳过 = 直接把 `t` 设到末尾；
 * - 播放中 = 时间累加；
 * - 重播 = `t` 清零。
 *
 * 分级演出（稀有度决定档位，事实由 core 的抽卡结果给出）：
 * - N / R：安静翻开；
 * - SR：光晕 + 铃音；
 * - SSR：**全屏爆点**（光爆 + 放射光束 + 粒子爆炸 + 震屏），独占时间，
 *   放完后进入**驻留**（画面停住 + 「点击任意处继续」提示），玩家可随时跳过。
 *
 * 音效为 WebAudio **合成**（无语音、不含任何配音素材）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { HERO_INDEX } from '../../core/config/heroes/index.ts'
import {
  burstParticles,
  chargeMotes,
  clamp01,
  ease,
  moteAt,
  particleAt,
  planReveal,
  projectReveal,
  REVEAL_TIMING,
  shakeOffset,
  type RevealItem,
  type RevealState,
} from '../utils/gacha-reveal.ts'
import { playRevealSound } from '../utils/gacha-audio.ts'

const props = defineProps<{ items: RevealItem[]; title?: string }>()
const emit = defineEmits<{ (e: 'finished'): void }>()

/** 事件表（一次演出内不变） */
const plan = planReveal(props.items)

/** 当前时刻（ms）——组件唯一的可变状态 */
const t = ref(0)

/** 画面状态：全部由 `t` 推导 */
const state = computed<RevealState>(() => projectReveal(t.value, plan))

const isSingle = computed(() => props.items.length === 1)

const canvasRef = ref<HTMLCanvasElement | null>(null)

// ─────────────────────────── 表现层取数 ───────────────────────────

function heroOf(index: number) {
  return HERO_INDEX.get(props.items[index]?.heroId ?? '')
}

function portraitOf(index: number): string {
  return heroOf(index)?.portrait ?? ''
}

function nameOf(index: number): string {
  const item = props.items[index]
  if (!item) return ''
  return heroOf(index)?.name ?? item.heroId
}

function rarityOf(index: number): string {
  return props.items[index]?.rarity ?? 'N'
}

function isNewOf(index: number): boolean {
  return props.items[index]?.isNew ?? false
}

const burstIndex = computed(() => state.value.burst?.event.index ?? -1)

// ─────────────────────────── 样式推导 ───────────────────────────

/** 根节点：承载震屏位移 */
const rootStyle = computed(() => {
  const s = shakeOffset(t.value, plan)
  return { transform: `translate3d(${s.x.toFixed(2)}px, ${s.y.toFixed(2)}px, 0)` }
})

/** 卡牌翻转：角度由推导出的进度算出（0..180°） */
function cardStyle(index: number) {
  const c = state.value.cards[index]
  return { transform: `rotateY(${((c?.flip ?? 0) * 180).toFixed(2)}deg)` }
}

/** SR 光晕环：扩散 + 淡出 */
function glowStyle(index: number) {
  const g = state.value.cards[index]?.glow ?? 0
  return {
    transform: `scale(${(0.72 + g * 0.85).toFixed(3)})`,
    opacity: (g * 0.95).toFixed(3),
    borderColor: `rgba(159, 198, 240, ${(0.35 + g * 0.65).toFixed(3)})`,
    boxShadow: `0 0 ${(10 + g * 26).toFixed(1)}px rgba(159, 198, 240, ${(g * 0.7).toFixed(3)})`,
  }
}

/** 蓄力层：光柱收束 + 文字淡出 */
const chargeStyle = computed(() => {
  const c = state.value.charge
  return {
    opacity: (1 - ease.inCubic(c) * 0.35).toFixed(3),
    transform: `scale(${(0.72 + c * 0.4).toFixed(3)})`,
  }
})

/**
 * 「召唤中」文字：蓄力时脉动，蓄力结束后 220ms 内淡出。
 *
 * ⚠ 不能用 CSS animation 做脉动——**动画的优先级高于行内样式**，
 *   会把「淡出」顶掉，导致文字压在卡阵上（历史坑：CSS 动画与行内 opacity 打架）。
 *   因此脉动也走 `t` 推导，与其它演出状态同源。
 */
const chargeLabelStyle = computed(() => {
  const now = t.value
  const pulse = 0.62 + 0.38 * Math.sin((now / 1000) * 5.2)
  if (now < REVEAL_TIMING.CHARGE_MS) {
    return { opacity: ((0.35 + (now / REVEAL_TIMING.CHARGE_MS) * 0.65) * pulse).toFixed(3) }
  }
  const fade = clamp01(1 - (now - REVEAL_TIMING.CHARGE_MS) / 220)
  return { opacity: (fade * pulse).toFixed(3) }
})

/** 顶部标题（卡池名）：随卡阵淡入，爆点时让位 */
const titleStyle = computed(() => {
  const inAlpha = clamp01((state.value.charge - 0.5) / 0.5)
  return { opacity: (inAlpha * (state.value.burst ? 0 : 1)).toFixed(3) }
})

/**
 * 全屏爆点层：暗角交给背景渐变。
 *
 * ⚠ 不要再给整层加 opacity——光束用 `mix-blend-mode: screen` 叠加，
 *   层透明度会把光束一起压成灰色（看着像「没打光」）。
 */
const burstStyle = computed(() => {
  const b = state.value.burst
  const p = b?.progress ?? 0
  const hold = b?.hold ?? 0
  // 驻留期间保持暗角（画面停住但不失掉「爆点」的氛围）
  const core = Math.max(ease.burst(p), hold > 0 ? 0.42 : 0)
  return {
    background: `radial-gradient(circle at 50% 46%, rgba(44, 34, 18, ${(0.55 + core * 0.4).toFixed(3)}) 0%, rgba(10, 8, 5, 0.92) 55%, rgba(4, 3, 2, 0.99) 100%)`,
  }
})

/** 放射光束：随时间加速旋转；驻留期间保持缓慢流转 */
const raysStyle = computed(() => {
  const b = state.value.burst
  const p = b?.progress ?? 0
  const hold = b?.hold ?? 0
  const drift = hold > 0 ? (t.value - (b?.event.fxEndAt ?? 0)) * 0.035 : 0
  return {
    transform: `rotate(${(p * 120 + drift).toFixed(2)}deg) scale(${(0.85 + p * 0.4).toFixed(3)})`,
    opacity: (hold > 0 ? 0.42 : 0.55 + ease.burst(p) * 0.45).toFixed(3),
  }
})

/** 爆点背光：从中心射出的竖直光束；驻留期间留一点余韵 */
const beamStyle = computed(() => {
  const b = state.value.burst
  const p = b?.progress ?? 0
  const hold = b?.hold ?? 0
  const core = ease.burst(p)
  return {
    opacity: (Math.max(core, hold > 0 ? 0.16 : 0) * 0.95).toFixed(3),
    transform: `translate(-50%, -50%) scaleX(${(0.45 + core * 0.85).toFixed(3)})`,
  }
})

/** 爆点大字（SSR）冲击：砸下来 → 定住 → 驻留末尾淡出 */
const wordStyle = computed(() => {
  const b = state.value.burst
  const p = b?.progress ?? 0
  const hold = b?.hold ?? 0
  const inA = clamp01(p / 0.14)
  // 动画期间一直亮着（玩家要看得清），驻留末尾才淡出
  const outA = hold > 0 ? clamp01((1 - hold) / 0.32) : 1
  const scale = p < 0.14 ? 1.65 - ease.outCubic(p / 0.14) * 0.65 : 1
  return {
    opacity: (inA * outA * 0.9).toFixed(3),
    transform: `translate(-50%, -50%) scale(${scale.toFixed(3)})`,
  }
})

/** 爆点主卡：回弹入场 → 悬浮 → 驻留（轻微起伏）→ 末尾淡出 */
const burstCardStyle = computed(() => {
  const b = state.value.burst
  const p = b?.progress ?? 0
  const hold = b?.hold ?? 0
  let scale: number
  if (p < 0.2) scale = 0.55 + ease.outBack(p / 0.2) * 0.55
  else scale = 1.1 - (p - 0.2) * 0.13
  // 驻留：轻微悬浮 + 呼吸，避免画面完全静止
  let dy = 0
  if (hold > 0) {
    const bob = Math.sin((t.value / 1000) * 2)
    scale = 1 + bob * 0.014
    dy = bob * 7
  }
  const fadeIn = p < 0.12 ? p / 0.12 : 1
  const fadeOut = hold > 0 ? clamp01((1 - hold) / 0.28) : 1
  return {
    transform: `translate(-50%, calc(-50% + ${dy.toFixed(1)}px)) scale(${scale.toFixed(3)})`,
    opacity: (fadeIn * fadeOut).toFixed(3),
  }
})

/**
 * 驻留提示「点击任意处继续」。
 *
 * 脉动同样走 `t` 推导（不用 CSS animation——动画优先级高于行内样式，
 * 会把行内 opacity 顶掉，同 AGENTS.md 铁律 #23 记的坑）。
 */
const holdHintStyle = computed(() => {
  const hold = state.value.burst?.hold ?? 0
  const a = clamp01((hold - 0.1) / 0.22)
  const pulse = 0.68 + 0.32 * Math.sin((t.value / 1000) * 3.2)
  return { opacity: (a * pulse).toFixed(3) }
})

/** 白光闪：爆点瞬间炸开再收敛 */
const flashStyle = computed(() => {
  const p = state.value.burst?.progress ?? 0
  const a = p < 0.1 ? p / 0.1 : Math.pow(1 - (p - 0.1) / 0.9, 2.4)
  return { opacity: Math.min(0.85, a * 0.85).toFixed(3) }
})

/** 卡阵整体：随蓄力淡入，爆点时整体退场（避免残影干扰爆点） */
const stageStyle = computed(() => {
  const c = state.value.charge
  const inAlpha = clamp01((c - 0.45) / 0.55)
  if (state.value.burst) {
    return { opacity: '0', transform: 'translateY(-4vh) scale(1.12)' }
  }
  return {
    opacity: inAlpha.toFixed(3),
    transform: `translateY(-4vh) scale(${(0.94 + inAlpha * 0.06).toFixed(3)})`,
  }
})

// ─────────────────────────── Canvas 特效 ───────────────────────────

const MOTES = chargeMotes(0x5a17, 46)
const PARTICLES = burstParticles(0xb0a5, 130)

function drawCharge(c: CanvasRenderingContext2D, w: number, h: number, st: RevealState): void {
  const cx = w / 2
  const cy = h * 0.46
  const k = st.charge

  // 光柱：随蓄力收束、变亮
  const colW = 34 + 130 * (1 - k)
  const grad = c.createLinearGradient(cx - colW, 0, cx + colW, 0)
  grad.addColorStop(0, 'rgba(232, 200, 122, 0)')
  grad.addColorStop(0.5, `rgba(255, 236, 190, ${(0.18 + k * 0.4).toFixed(3)})`)
  grad.addColorStop(1, 'rgba(232, 200, 122, 0)')
  c.fillStyle = grad
  c.fillRect(cx - colW, 0, colW * 2, h)

  // 旋转符文环
  c.save()
  c.translate(cx, cy)
  c.strokeStyle = `rgba(232, 200, 122, ${(0.18 + k * 0.5).toFixed(3)})`
  c.lineWidth = 1.4
  for (let ring = 0; ring < 2; ring++) {
    const radius = 74 + ring * 46 + k * 16
    const dir = ring % 2 === 0 ? 1 : -1
    c.beginPath()
    c.arc(0, 0, radius, 0, Math.PI * 2)
    c.stroke()
    // 刻度
    const ticks = 12 + ring * 6
    for (let i = 0; i < ticks; i++) {
      const a = (i / ticks) * Math.PI * 2 + (t.value / 1000) * dir * (0.6 + ring * 0.4)
      const r1 = radius
      const r2 = radius + 6 + k * 5
      c.beginPath()
      c.moveTo(Math.cos(a) * r1, Math.sin(a) * r1)
      c.lineTo(Math.cos(a) * r2, Math.sin(a) * r2)
      c.stroke()
    }
  }
  c.restore()

  // 上升光点
  c.save()
  c.globalCompositeOperation = 'lighter'
  for (const m of MOTES) {
    const f = moteAt(m, t.value)
    const x = f.x * w
    const y = f.y * h
    const a = f.alpha * (0.25 + k * 0.75)
    if (a <= 0.01) continue
    c.fillStyle = `rgba(255, 231, 178, ${a.toFixed(3)})`
    c.beginPath()
    c.arc(x, y, f.size * (0.7 + k * 0.6), 0, Math.PI * 2)
    c.fill()
  }
  c.restore()
}

function drawBurst(c: CanvasRenderingContext2D, w: number, h: number, st: RevealState): void {
  const burst = st.burst
  if (!burst) return
  const cx = w / 2
  const cy = h * 0.46
  const age = t.value - burst.event.fxAt
  const p = burst.progress
  // 扩散半径要够大：主卡会盖住中心 ±160px，粒子太近就全被卡片挡住
  const scale = Math.max(w, h) * 0.62

  // 核心光爆
  const core = ease.burst(p)
  const rad = 30 + 300 * core
  const g = c.createRadialGradient(cx, cy, 0, cx, cy, rad)
  g.addColorStop(0, `rgba(255, 252, 240, ${(core * 0.95).toFixed(3)})`)
  g.addColorStop(0.22, `rgba(255, 226, 160, ${(core * 0.6).toFixed(3)})`)
  g.addColorStop(0.55, `rgba(232, 186, 96, ${(core * 0.22).toFixed(3)})`)
  g.addColorStop(1, 'rgba(232, 200, 122, 0)')
  c.fillStyle = g
  c.beginPath()
  c.arc(cx, cy, rad, 0, Math.PI * 2)
  c.fill()

  // 粒子爆炸（沿飞行方向拉成火花条）
  c.save()
  c.globalCompositeOperation = 'lighter'
  for (const pt of PARTICLES) {
    const f = particleAt(pt, age)
    if (f.alpha <= 0.01) continue
    const x = cx + f.x * scale
    const y = cy + f.y * scale
    if (x < -20 || x > w + 20 || y < -20 || y > h + 20) continue
    const hot = pt.tint > 0.62
    c.fillStyle = hot
      ? `rgba(255, 253, 244, ${Math.min(1, f.alpha * 1.1).toFixed(3)})`
      : `rgba(248, 206, 116, ${f.alpha.toFixed(3)})`
    c.save()
    c.translate(x, y)
    c.rotate(pt.angle)
    const s = f.size
    c.fillRect(-s * 2.1, -s * 0.24, s * 4.2, s * 0.48)
    c.restore()
  }
  c.restore()
}

function draw(): void {
  const canvas = canvasRef.value
  if (!canvas) return
  // 铁律 #17：先取 ctx → 再设尺寸 → 最后 setTransform
  const c = canvas.getContext('2d')
  if (!c) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  const pw = Math.round(w * dpr)
  const ph = Math.round(h * dpr)
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw
    canvas.height = ph
  }
  c.setTransform(dpr, 0, 0, dpr, 0, 0)
  c.clearRect(0, 0, w, h)

  const st = state.value
  if (st.phase === 'charge') drawCharge(c, w, h, st)
  if (st.burst) drawBurst(c, w, h, st)
}

// ─────────────────────────── 播放循环 ───────────────────────────

let raf = 0
let lastTs = 0
/** 上一帧的推导状态：仅用于「音效触发」的边沿检测，不累积任何演出状态 */
let prevState: RevealState | null = null
/** 上一帧的演出时刻：用于识别「跳过」造成的时间跳变 */
let lastProjectedT = 0

function fireSounds(cur: RevealState, jumped: boolean): void {
  const prev = prevState
  prevState = cur
  if (!prev || jumped) return
  for (let i = 0; i < cur.cards.length; i++) {
    const now = cur.cards[i]
    const before = prev.cards[i]
    if (!now.revealed || before?.revealed) continue
    if (now.tier === 'burst') playRevealSound('burst')
    else if (now.tier === 'glow') playRevealSound('glow')
    else playRevealSound('flip')
  }
}

function loop(ts: number): void {
  if (!lastTs) lastTs = ts
  // 卡顿时限幅，避免一帧跳太多导致演出"瞬移"
  const dt = Math.min(64, ts - lastTs)
  lastTs = ts
  t.value = Math.min(plan.duration, t.value + dt)
  const st = state.value
  // 时间跳变（跳过）时不要把「跳过的卡牌」当成逐张翻开，否则会齐响一片
  fireSounds(st, t.value - lastProjectedT > 150)
  lastProjectedT = t.value
  draw()
  if (st.done) {
    emit('finished')
    return
  }
  raf = requestAnimationFrame(loop)
}

function skip(): void {
  if (t.value >= plan.duration) return
  playRevealSound('skip')
  t.value = plan.duration
  draw()
}

onMounted(() => {
  // 尊重「减少动态效果」的系统偏好：直接跳到结算
  try {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      t.value = plan.duration
      emit('finished')
      return
    }
  } catch {
    // matchMedia 不可用：继续正常演出
  }
  playRevealSound('charge')
  raf = requestAnimationFrame(loop)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
})
</script>

<template>
  <div class="reveal" data-testid="gacha-reveal" :style="rootStyle" @click="skip">
    <canvas ref="canvasRef" class="fx"></canvas>

    <!-- 蓄力 -->
    <div class="charge" :style="chargeStyle">
      <div class="charge-label" :style="chargeLabelStyle">召唤中</div>
    </div>

    <!-- 顶部标题 -->
    <div class="title" :style="titleStyle">{{ title }}</div>

    <!-- 卡阵 -->
    <div class="stage" :class="{ single: isSingle }" :style="stageStyle">
      <div v-for="(card, i) in state.cards" :key="i" class="slot" data-testid="gacha-reveal-card">
        <div class="card" :style="cardStyle(i)">
          <div class="face back">
            <span class="sigil">圣</span>
          </div>
          <div class="face front" :class="[`rarity-${rarityOf(i).toLowerCase()}`, { dup: !isNewOf(i) }]">
            <img class="art" :src="portraitOf(i)" :alt="nameOf(i)" />
            <span class="tag" :class="`tag-${rarityOf(i).toLowerCase()}`">{{ rarityOf(i) }}</span>
            <span v-if="!isNewOf(i)" class="dup-mark">重复</span>
            <span class="name">{{ nameOf(i) }}</span>
          </div>
        </div>
        <div v-if="card.glow > 0" class="glow" :style="glowStyle(i)"></div>
      </div>
    </div>

    <!-- 全屏爆点 · 背景层（暗角 + 背光 + 白闪） -->
    <div v-if="state.burst" class="burst-bg" :style="burstStyle">
      <div class="burst-beam" :style="beamStyle"></div>
      <div class="rays" :style="raysStyle"></div>
      <div class="flash" :style="flashStyle"></div>
    </div>

    <!-- 爆点大字与主卡：画在粒子层之上，保持锐利 -->
    <div v-if="state.burst" class="burst-word" :style="wordStyle">SSR</div>
    <div v-if="state.burst" class="burst-card" :style="burstCardStyle" data-testid="gacha-burst">
      <img class="art" :src="portraitOf(burstIndex)" :alt="nameOf(burstIndex)" />
      <div class="burst-meta">
        <span class="tag tag-ssr">SSR</span>
        <span class="name">{{ nameOf(burstIndex) }}</span>
        <span class="sub">{{ isNewOf(burstIndex) ? '新获得' : '重复转化' }}</span>
      </div>
    </div>

    <!-- 驻留提示：爆点放完后画面停住，玩家可点击继续 -->
    <div
      v-if="state.burst && state.burst.hold > 0"
      class="hold-hint"
      data-testid="gacha-hold-hint"
      :style="holdHintStyle"
    >
      点击任意处继续
    </div>

    <button class="skip" data-testid="gacha-skip" @click.stop="skip">跳过</button>
  </div>
</template>

<style scoped>
.reveal {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: radial-gradient(circle at 50% 42%, #1d1811 0%, #0b0907 62%, #050403 100%);
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  will-change: transform;
}

.reveal::before {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(
    ellipse 72% 44% at 50% 48%,
    rgba(232, 200, 122, 0.1) 0%,
    rgba(232, 200, 122, 0) 72%
  );
  pointer-events: none;
}

.fx {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  /* 画布压在爆点背景之上、卡片之下——否则粒子会被背景层盖住 */
  z-index: 3;
}

/* ── 蓄力 ─────────────────────────────────────────── */
.charge {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 26vh;
  pointer-events: none;
}

.charge-label {
  font-size: 15px;
  letter-spacing: 0.5em;
  text-indent: 0.5em;
  color: var(--c-gold-2);
  text-shadow: 0 0 18px rgba(232, 200, 122, 0.75);
}

/* 顶部标题（卡池名） */
.title {
  position: absolute;
  top: 52px;
  z-index: 2;
  left: 0;
  right: 0;
  text-align: center;
  font-size: 13px;
  letter-spacing: 0.32em;
  text-indent: 0.32em;
  color: var(--c-gold);
  pointer-events: none;
}

/* ── 卡阵 ─────────────────────────────────────────── */
.stage {
  position: relative;
  z-index: 2;
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 10px 8px;
  width: 100%;
  max-width: 404px;
  padding: 0 12px;
}

.stage.single {
  grid-template-columns: 1fr;
  max-width: 200px;
}

.slot {
  position: relative;
  aspect-ratio: 3 / 4;
  perspective: 760px;
}

.card {
  position: relative;
  width: 100%;
  height: 100%;
  transform-style: preserve-3d;
  will-change: transform;
}

.face {
  position: absolute;
  inset: 0;
  border-radius: 9px;
  overflow: hidden;
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
}

.face.back {
  background:
    radial-gradient(circle at 50% 42%, rgba(232, 200, 122, 0.16) 0%, rgba(232, 200, 122, 0) 58%),
    linear-gradient(160deg, #2c261c 0%, #191510 62%, #12100c 100%);
  border: 1px solid #4a4132;
  display: flex;
  align-items: center;
  justify-content: center;
}

.sigil {
  width: 46%;
  aspect-ratio: 1;
  border-radius: 50%;
  border: 1px solid rgba(232, 200, 122, 0.55);
  color: rgba(232, 200, 122, 0.9);
  font-size: 15px;
  display: flex;
  align-items: center;
  justify-content: center;
  letter-spacing: 0;
  box-shadow: inset 0 0 14px rgba(232, 200, 122, 0.28);
}

.face.front {
  transform: rotateY(180deg);
  border: 1px solid #3a342a;
  background: #14120f;
}

.face.front.rarity-ssr {
  border-color: #8a7233;
  box-shadow: 0 0 12px rgba(232, 200, 122, 0.5);
}

.face.front.rarity-sr {
  border-color: #46617f;
  box-shadow: 0 0 9px rgba(159, 198, 240, 0.4);
}

.face.front.dup .art {
  filter: saturate(0.55) brightness(0.78);
}

.art {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.face .tag {
  position: absolute;
  top: 3px;
  left: 3px;
  font-size: 9px;
  padding: 0 4px;
  border-radius: 4px;
  background: rgba(8, 7, 5, 0.78);
  border: 1px solid;
}

.dup-mark {
  position: absolute;
  top: 3px;
  right: 3px;
  font-size: 9px;
  padding: 0 4px;
  border-radius: 4px;
  background: rgba(8, 7, 5, 0.78);
  border: 1px solid #4a4a52;
  color: var(--r-n);
}

.face .name {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 2px 3px;
  font-size: 10px;
  text-align: center;
  color: var(--c-text);
  background: linear-gradient(to top, rgba(6, 5, 4, 0.94) 40%, rgba(6, 5, 4, 0));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* SR 光晕 */
.glow {
  position: absolute;
  inset: -8%;
  border: 2px solid rgba(159, 198, 240, 0.8);
  border-radius: 12px;
  pointer-events: none;
}

/* ── SSR 全屏爆点 ─────────────────────────────────── */
.burst-bg {
  position: absolute;
  inset: 0;
  overflow: hidden;
  z-index: 1;
}

.rays {
  position: absolute;
  left: 50%;
  top: 46%;
  width: 160vmax;
  height: 160vmax;
  margin: -80vmax 0 0 -80vmax;
  background: repeating-conic-gradient(
    from 0deg,
    rgba(255, 228, 166, 0.9) 0deg 1.8deg,
    rgba(255, 228, 166, 0) 1.8deg 8deg
  );
  mix-blend-mode: screen;
  -webkit-mask-image: radial-gradient(
    circle at 50% 50%,
    transparent 6%,
    rgba(0, 0, 0, 0.5) 20%,
    #000 42%,
    transparent 74%
  );
  mask-image: radial-gradient(
    circle at 50% 50%,
    transparent 6%,
    rgba(0, 0, 0, 0.5) 20%,
    #000 42%,
    transparent 74%
  );
}

.burst-beam {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 46%;
  height: 132%;
  background: linear-gradient(
    to bottom,
    rgba(255, 228, 166, 0) 0%,
    rgba(255, 228, 166, 0.14) 32%,
    rgba(255, 242, 208, 0.4) 50%,
    rgba(255, 228, 166, 0.14) 68%,
    rgba(255, 228, 166, 0) 100%
  );
  filter: blur(10px);
  pointer-events: none;
}

.burst-card {
  position: absolute;
  left: 50%;
  top: 50%;
  z-index: 4;
  width: 72%;
  max-width: 262px;
  border-radius: 14px;
  overflow: hidden;
  border: 2px solid var(--r-ssr);
  box-shadow:
    0 0 40px rgba(232, 200, 122, 0.75),
    0 0 90px rgba(232, 200, 122, 0.42);
  background: #100d09;
}

.burst-card .art {
  width: 100%;
  aspect-ratio: 3 / 4;
  object-fit: cover;
}

.burst-meta {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 8px 6px 9px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  background: linear-gradient(to top, rgba(5, 4, 3, 0.96) 46%, rgba(5, 4, 3, 0));
}

.burst-meta .name {
  font-size: 15px;
  color: var(--c-gold-2);
  text-shadow: 0 0 14px rgba(232, 200, 122, 0.6);
}

.burst-meta .sub {
  font-size: 11px;
  color: var(--c-text-dim);
}

.burst-word {
  position: absolute;
  left: 50%;
  top: 17%;
  z-index: 4;
  font-size: 74px;
  font-weight: 800;
  letter-spacing: 0.06em;
  color: transparent;
  background: linear-gradient(180deg, #fff8e6 0%, #f0d089 42%, #b98f3f 100%);
  -webkit-background-clip: text;
  background-clip: text;
  filter: drop-shadow(0 0 26px rgba(232, 200, 122, 0.85));
  pointer-events: none;
}

.flash {
  position: absolute;
  inset: 0;
  background: radial-gradient(
    circle at 50% 46%,
    rgba(255, 253, 246, 0.92) 0%,
    rgba(255, 250, 240, 0.5) 45%,
    rgba(255, 240, 210, 0) 86%
  );
  pointer-events: none;
}

/* ── 驻留提示（SSR 爆点后停住）───────────────────── */
.hold-hint {
  position: absolute;
  left: 50%;
  bottom: 11%;
  transform: translateX(-50%);
  z-index: 5;
  font-size: 13px;
  letter-spacing: 0.22em;
  text-indent: 0.22em;
  color: var(--c-gold-2);
  text-shadow: 0 0 16px rgba(232, 200, 122, 0.55);
  pointer-events: none;
  white-space: nowrap;
}

/* ── 跳过 ─────────────────────────────────────────── */
.skip {
  position: absolute;
  right: 14px;
  top: 14px;
  z-index: 5;
  padding: 6px 14px;
  font-size: 12px;
  color: var(--c-text-dim);
  border: 1px solid var(--c-line-2);
  border-radius: 999px;
  background: rgba(10, 9, 7, 0.72);
}
</style>
