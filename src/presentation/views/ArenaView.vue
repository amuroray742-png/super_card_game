<script setup lang="ts">
/**
 * 竞技场：归一化对战。
 * 快照、段位与对局结果均来自 core；产出隔离文案为合规硬要求。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useGameStore } from '../stores/game'
import { tierForPoints } from '../../core/systems/arena.ts'
import { HERO_INDEX } from '../../core/config/heroes/index.ts'
import { RELIC_SETS } from '../../core/systems/relic.ts'
import { formatNumber } from '../utils/format'
import type { ArenaMatch } from '../../core/model/types.ts'

const store = useGameStore()
const router = useRouter()

const arena = computed(() => store.save.arena)
const loadout = computed(() => store.arenaLoadout)
const hash = computed(() => store.arenaHash)

/** 当前段位 */
const tier = computed(() => tierForPoints(arena.value.tierPoints))

/** 铭文槽位（上限由 core 配置决定） */
const runeSlots = computed(() => loadout.value.runes.length)

/** 对战结果 */
const match = ref<ArenaMatch | null>(null)

async function runMatch() {
  if (store.teamEmpty) {
    store.notify('请先在阵位中编队', 'warn')
    return
  }
  const result = store.runArenaMatch()
  match.value = result
  // 结算入账：段位分 / 勋章 / 竞技专属产出（不回流 PVE 经济）
  const reward = await store.settleArena(result)
  // 存档冲突时结算整体回滚，persist 已提示玩家，这里不再重复播报奖励
  if (!reward) return
  store.notify(
    result.result.win
      ? `挑战成功 · 段位分 ${result.pointsDelta >= 0 ? '+' : ''}${result.pointsDelta} · 勋章 +${reward.medals}`
      : `挑战失败 · 段位分 ${result.pointsDelta} · 勋章 +${reward.medals}`,
    result.result.win ? 'ok' : 'info',
  )
}

function heroName(id: string | null): string {
  if (!id) return '空'
  return HERO_INDEX.get(id)?.name ?? id
}

function setName(id: string | null): string {
  if (!id) return '—'
  return RELIC_SETS.get(id)?.name ?? id
}
</script>

<template>
  <div class="page">
    <div class="page-title">竞技场</div>

    <!-- 隔离说明 -->
    <section class="panel notice">
      <div class="panel-title"><span>竞技归一化</span></div>
      <p class="tiny" style="margin: 0; line-height: 1.8; color: var(--c-text-dim)">
        竞技场内的单位属性按定位模板重置，等级、遗物强化等级、遗物随机词条、印记与永久加成均不参与计算。
        星级被动、羁绊与遗物套装效果按固定系数计入，仅保留策略维度。
      </p>
      <p class="tiny warn-text" style="margin: 8px 0 0; line-height: 1.8">
        竞技场<b>不提供银两、经验、强化石、圣杯结晶</b>，产出不会回流主线养成经济。
      </p>
    </section>

    <!-- 我的段位 -->
    <section class="panel">
      <div class="panel-title">
        <span>我的竞技数据</span>
        <button class="btn btn-sm btn-ghost" @click="router.push('/arena/rank')">天梯 ›</button>
      </div>
      <div class="grid-3">
        <div class="metric">
          <div class="tiny muted">段位</div>
          <div class="metric-num gold">{{ tier }}</div>
        </div>
        <div class="metric">
          <div class="tiny muted">竞技等级</div>
          <div class="metric-num">{{ arena.arenaLevel }}</div>
        </div>
        <div class="metric">
          <div class="tiny muted">勋章</div>
          <div class="metric-num">{{ formatNumber(arena.medals) }}</div>
        </div>
      </div>
      <div class="row-between tiny" style="margin-top: 10px">
        <span class="muted">段位分</span>
        <b>{{ formatNumber(arena.tierPoints) }}</b>
      </div>
      <div class="row-between tiny">
        <span class="muted">对战分</span>
        <b>{{ formatNumber(arena.pvpPoints) }}</b>
      </div>
      <div class="row-between tiny">
        <span class="muted">战术铭文</span>
        <b>{{ runeSlots }} / 3</b>
      </div>
    </section>

    <!-- 阵容快照 -->
    <section class="panel">
      <div class="panel-title">
        <span>阵容快照</span>
        <span class="tiny muted">指纹 {{ hash }}</span>
      </div>
      <div v-if="store.teamEmpty" class="empty">尚未编队，无法进入竞技</div>
      <div v-else>
        <div v-for="(id, i) in loadout.heroes" :key="i" class="row-between tiny snap-row">
          <span>{{ i + 1 }}. {{ heroName(id) }}</span>
          <span class="muted">
            {{ loadout.stars[i] }}★ · 技能 {{ loadout.skills[i]?.join('/') }} · 套装 {{ setName(loadout.relicSets[i]) }}
          </span>
        </div>
        <p class="tiny muted" style="margin: 8px 0 0">匹配后快照即冻结，换阵需重新发起挑战。</p>
      </div>
    </section>

    <!-- 挑战 -->
    <section class="panel">
      <div class="panel-title"><span>挑战</span></div>
      <button class="btn btn-primary btn-block" @click="runMatch">发起挑战</button>
    </section>

    <!-- 对战结果 -->
    <section v-if="match" class="panel">
      <div class="panel-title">
        <span>对战结果</span>
        <span class="tag" :class="match.result.win ? 'tag-sr' : ''">
          {{ match.result.win ? '胜利' : '失败' }}
        </span>
      </div>
      <div class="row-between tiny">
        <span class="muted">对手</span>
        <b>{{ match.opponentName }}</b>
      </div>
      <div class="row-between tiny">
        <span class="muted">回合数</span>
        <b>{{ match.result.rounds }}</b>
      </div>
      <div class="row-between tiny">
        <span class="muted">我方存活</span>
        <b>{{ match.result.survivors.length }} / {{ loadout.heroes.filter(Boolean).length }}</b>
      </div>
      <div class="row-between tiny">
        <span class="muted">对手人数</span>
        <b>{{ match.opponentLoadout.heroes.filter(Boolean).length }}</b>
      </div>
      <div class="row-between tiny">
        <span class="muted">段位分变化</span>
        <b :class="match.pointsDelta >= 0 ? 'ok-text' : 'warn-text'">
          {{ match.pointsDelta >= 0 ? '+' : '' }}{{ match.pointsDelta }}
        </b>
      </div>
    </section>
  </div>
</template>

<style scoped>
.notice {
  border-color: #6b5a2c;
}

.metric {
  padding: 8px;
  border-radius: 8px;
  background: var(--c-bg-2);
  border: 1px solid var(--c-line);
  text-align: center;
}

.metric-num {
  font-size: 18px;
  font-weight: 700;
  margin-top: 2px;
}

.gold {
  color: var(--c-gold-2);
}

.ok-text {
  color: var(--c-green);
}

.warn-text {
  color: #e0a06a;
}

.snap-row {
  padding: 5px 0;
  border-bottom: 1px solid var(--c-line);
}

.snap-row:last-child {
  border-bottom: none;
}
</style>
