<script setup lang="ts">
/**
 * 新手引导：召唤 → 编队 → 推征，共 3 步。
 * 引导进度记录在 store.guideStep，存档中的首次开始时间用于展示。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useGameStore } from '../stores/game'

const store = useGameStore()
const router = useRouter()

interface GuideStep {
  title: string
  desc: string
  detail: string
  action: string
  to: string
}

const STEPS: GuideStep[] = [
  {
    title: '召唤英灵',
    desc: '前往召唤页，用圣杯结晶或抽卡券抽取英灵。',
    detail: '概率与保底规则在召唤页与合规页均有公示；重复获得的英灵会转化为英灵印记。',
    action: '前往召唤',
    to: '/gacha',
  },
  {
    title: '编队入阵',
    desc: '在阵位页把英灵放入前排与后排共 6 个槽位。',
    detail: '猛将与统帅适合前排，谋士、医者与器者适合后排；凑齐标签可以激活羁绊。',
    action: '前往阵位',
    to: '/formation',
  },
  {
    title: '推征挂机',
    desc: '在推征页选择关卡并设为挂机目标，队伍会自动推进。',
    detail: '推征会持续结算银两、经验与养成材料，队伍战力不足时可回到养成页提升。',
    action: '前往推征',
    to: '/expedition',
  },
]

/** 当前步骤（0 起） */
const step = ref(store.guideStep < 0 ? 0 : store.guideStep)
const current = computed(() => STEPS[Math.min(step.value, STEPS.length - 1)])
const isLast = computed(() => step.value >= STEPS.length - 1)

/** 首次开始时间 */
const firstStart = computed(() => {
  const ts = store.save.stats.firstStartAt
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString('zh-CN')
})

function prev() {
  if (step.value > 0) step.value -= 1
}

function next() {
  if (isLast.value) {
    finish()
    return
  }
  step.value += 1
  store.guideStep = step.value
  store.persist()
}

function finish() {
  store.markGuideDone()
  router.push('/expedition')
}

function gotoStep() {
  router.push(current.value.to)
}
</script>

<template>
  <div class="page">
    <div class="page-title">新手引导</div>

    <!-- 步骤指示 -->
    <section class="panel">
      <div class="steps">
        <div v-for="(s, i) in STEPS" :key="s.title" class="step-dot" :class="{ on: i === step }">
          <span class="dot">{{ i + 1 }}</span>
          <span class="tiny">{{ s.title }}</span>
        </div>
      </div>
      <div class="bar" style="margin-top: 10px">
        <i :style="{ width: `${((step + 1) / STEPS.length) * 100}%` }"></i>
      </div>
    </section>

    <!-- 步骤内容 -->
    <section class="panel guide-card">
      <div class="guide-title">{{ current.title }}</div>
      <p class="guide-desc">{{ current.desc }}</p>
      <p class="tiny muted" style="line-height: 1.8">{{ current.detail }}</p>
      <button class="btn btn-block" style="margin-top: 12px" @click="gotoStep">{{ current.action }}</button>
    </section>

    <!-- 导航 -->
    <div class="row" style="gap: 8px">
      <button class="btn" style="flex: 1" :disabled="step === 0" @click="prev">上一步</button>
      <button class="btn btn-primary" style="flex: 1" @click="next">
        {{ isLast ? '开始游戏' : '下一步' }}
      </button>
    </div>

    <section class="panel" style="margin-top: 12px">
      <div class="row-between tiny">
        <span class="muted">首次开始时间</span>
        <b>{{ firstStart }}</b>
      </div>
      <div class="row-between tiny">
        <span class="muted">当前步骤</span>
        <b>{{ step + 1 }} / {{ STEPS.length }}</b>
      </div>
    </section>
  </div>
</template>

<style scoped>
.steps {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
}

.step-dot {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 4px;
  border-radius: 8px;
  border: 1px solid var(--c-line);
  background: var(--c-bg-2);
  color: var(--c-text-mute);
}

.step-dot.on {
  border-color: var(--c-gold);
  background: #2a2419;
  color: var(--c-gold-2);
}

.dot {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  border: 1px solid currentColor;
}

.guide-card {
  padding: 16px 12px;
}

.guide-title {
  font-size: 18px;
  font-weight: 700;
  color: var(--c-gold-2);
  margin-bottom: 6px;
}

.guide-desc {
  margin: 0 0 8px;
  font-size: 13px;
  line-height: 1.8;
  color: var(--c-text);
}
</style>
