/**
 * 抽卡演出音效（**WebAudio 合成**：零素材、零依赖）。
 *
 * 合规说明：项目红线是「不做**配音**」——本模块只合成**无语音音效**
 * （蓄力嗡鸣 / 翻牌轻响 / 光效铃音 / 爆点轰鸣），不含任何人声与语音文本。
 *
 * 自动播放策略：移动端浏览器要求音频上下文必须在**用户手势**中创建或恢复，
 * 因此首次点击「单抽 / 十连」时同步调用 `unlockAudio()`（此时仍在手势调用栈内）。
 * 解锁失败或环境不支持时全部静默降级，绝不影响抽卡流程。
 */

export type RevealSound = 'charge' | 'flip' | 'glow' | 'burst' | 'skip'

let ctx: AudioContext | null = null
let master: GainNode | null = null
let noiseBuffer: AudioBuffer | null = null
let enabled = true

/** 浏览器是否支持 WebAudio */
function hasAudio(): boolean {
  return typeof window !== 'undefined' && typeof window.AudioContext !== 'undefined'
}

/**
 * 解锁音频上下文（必须在用户手势中调用）。
 *
 * 幂等：重复调用只做「恢复挂起状态」。
 */
export function unlockAudio(): void {
  if (!enabled || !hasAudio()) return
  try {
    if (!ctx) {
      ctx = new window.AudioContext()
      master = ctx.createGain()
      master.gain.value = 0.9
      master.connect(ctx.destination)
    }
    if (ctx.state === 'suspended') void ctx.resume()
  } catch {
    // 环境不支持 / 被策略拦截：静默降级
    ctx = null
    master = null
  }
}

/** 开关音效（供设置项调用） */
export function setSoundEnabled(on: boolean): void {
  enabled = on
  if (!on && ctx && ctx.state === 'running') void ctx.suspend()
  if (on && ctx && ctx.state === 'suspended') void ctx.resume()
}

/** 当前是否可用（供表现层判断要不要提示） */
export function soundAvailable(): boolean {
  return enabled && hasAudio()
}

function getNoise(ctxRef: AudioContext): AudioBuffer {
  if (noiseBuffer) return noiseBuffer
  const len = Math.floor(ctxRef.sampleRate * 1.2)
  const buf = ctxRef.createBuffer(1, len, ctxRef.sampleRate)
  const data = buf.getChannelData(0)
  // 确定性白噪声：同一 seed 每次听感一致
  let seed = 0x2f6e2b1
  for (let i = 0; i < len; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0
    data[i] = (seed / 0xffffffff) * 2 - 1
  }
  noiseBuffer = buf
  return buf
}

interface ToneOptions {
  type?: OscillatorType
  from: number
  to?: number
  duration: number
  gain?: number
  delay?: number
  /** 结束前的衰减占比（0 = 线性淡出，1 = 快速淡出） */
  curve?: number
}

function playTone(c: AudioContext, out: GainNode, o: ToneOptions): void {
  const start = c.currentTime + (o.delay ?? 0)
  const dur = Math.max(0.01, o.duration)
  const osc = c.createOscillator()
  osc.type = o.type ?? 'sine'
  osc.frequency.setValueAtTime(Math.max(20, o.from), start)
  if (o.to !== undefined && o.to !== o.from) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), start + dur)
  }
  const g = c.createGain()
  const peak = o.gain ?? 0.12
  g.gain.setValueAtTime(0.0001, start)
  g.gain.exponentialRampToValueAtTime(peak, start + Math.min(0.02, dur * 0.2))
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur)
  osc.connect(g)
  g.connect(out)
  osc.start(start)
  osc.stop(start + dur + 0.02)
}

interface NoiseOptions {
  duration: number
  gain?: number
  delay?: number
  /** 带通中心频率 */
  freq: number
  /** 扫向的截止频率 */
  sweepTo?: number
  type?: BiquadFilterType
}

function playNoise(c: AudioContext, out: GainNode, o: NoiseOptions): void {
  const start = c.currentTime + (o.delay ?? 0)
  const dur = Math.max(0.02, o.duration)
  const src = c.createBufferSource()
  src.buffer = getNoise(c)
  const filter = c.createBiquadFilter()
  filter.type = o.type ?? 'bandpass'
  filter.frequency.setValueAtTime(Math.max(40, o.freq), start)
  if (o.sweepTo !== undefined) {
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, o.sweepTo), start + dur)
  }
  filter.Q.value = 1.1
  const g = c.createGain()
  g.gain.setValueAtTime(0.0001, start)
  g.gain.exponentialRampToValueAtTime(o.gain ?? 0.08, start + 0.012)
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur)
  src.connect(filter)
  filter.connect(g)
  g.connect(out)
  src.start(start)
  src.stop(start + dur + 0.02)
}

/**
 * 播放一次演出音效。
 *
 * 全部包在 try/catch 里——音效失败绝不能影响抽卡与演出。
 */
export function playRevealSound(kind: RevealSound): void {
  if (!enabled) return
  if (!ctx || !master) {
    unlockAudio()
    if (!ctx || !master) return
  }
  const c = ctx
  const out = master
  try {
    if (c.state === 'suspended') void c.resume()
    switch (kind) {
      case 'charge': {
        // 蓄力：低频嗡鸣向上收束
        playTone(c, out, { type: 'sawtooth', from: 150, to: 620, duration: 0.62, gain: 0.05 })
        playTone(c, out, { type: 'sine', from: 300, to: 1240, duration: 0.6, gain: 0.035, delay: 0.04 })
        playNoise(c, out, { duration: 0.6, gain: 0.03, freq: 400, sweepTo: 3200, type: 'bandpass' })
        break
      }
      case 'flip': {
        // 翻牌：干脆的轻响
        playNoise(c, out, { duration: 0.09, gain: 0.07, freq: 2600 })
        playTone(c, out, { type: 'sine', from: 880, to: 1320, duration: 0.08, gain: 0.05 })
        break
      }
      case 'glow': {
        // SR 光效：两声泛音铃音
        playTone(c, out, { type: 'sine', from: 784, duration: 0.5, gain: 0.09 })
        playTone(c, out, { type: 'sine', from: 1175, duration: 0.42, gain: 0.06, delay: 0.05 })
        playTone(c, out, { type: 'triangle', from: 2350, duration: 0.3, gain: 0.025, delay: 0.02 })
        break
      }
      case 'burst': {
        // SSR 爆点：低频轰鸣 + 宽频爆炸 + 高频泛光
        playTone(c, out, { type: 'sine', from: 190, to: 38, duration: 1.0, gain: 0.22 })
        playNoise(c, out, { duration: 0.85, gain: 0.16, freq: 5200, sweepTo: 260, type: 'lowpass' })
        playTone(c, out, { type: 'sine', from: 1568, duration: 0.62, gain: 0.07, delay: 0.03 })
        playTone(c, out, { type: 'sine', from: 2093, duration: 0.55, gain: 0.05, delay: 0.08 })
        playTone(c, out, { type: 'triangle', from: 3136, duration: 0.4, gain: 0.03, delay: 0.12 })
        break
      }
      case 'skip': {
        playTone(c, out, { type: 'sine', from: 620, to: 190, duration: 0.18, gain: 0.06 })
        break
      }
    }
  } catch {
    // 静默降级
  }
}
