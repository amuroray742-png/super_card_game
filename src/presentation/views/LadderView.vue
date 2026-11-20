<script setup lang="ts">
/**
 * 演武场 · PVE 三队天梯（§9.1 / roadmap P2-2）。
 *
 * ── 三条口径（界面必须写出来，玩家才知道自己在玩什么）────────────────
 * 1. **PVE 完整数值**：本模式走 `resolveStats(mode:'pve')`，等级 / 遗物强化 /
 *    羁绊 / 永久加成全部生效——它是检验养成成果的舞台，与竞技场的归一化不同。
 * 2. **架空演武**：敌方梯队是灵体投影，不是历史人物对决。
 * 3. **产出隔离**：只发竞技勋章与竞技材料，不回流养成经济。
 *
 * 战斗事实（胜负 / 回合 / 存活 / 名册）一律取 core 的结果，界面不自行推导。
 */
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useGameStore } from '../stores/game'
import { LADDER_TIERS } from '../../core/config/ladder.ts'
import { HERO_INDEX } from '../../core/config/heroes/index.ts'
import { getEnemy } from '../../core/config/enemies.ts'
import { LADDER } from '../../core/config/economy.ts'
import { formatNumber } from '../utils/format'
import { rewardLines } from '../utils/reward-text'
import type { LadderRoundResult } from '../../core/model/types.ts'
import type { LadderChallengeResult } from '../../core/systems/actions.ts'

const store = useGameStore()
const router = useRouter()

const arena = computed(() => store.save.arena)
const ladder = computed(() => store.save.arena.ladder)

/** 梯队层（当前段位决定） */
const tierIndex = computed(() => store.ladderTierIndex)
const tierDef = computed(() => LADDER_TIERS[tierIndex.value] ?? LADDER_TIERS[0])

/** 本周是否已挑战 */
const settled = computed(() => store.ladderSettledThisWeek)

// ─────────────────────────── 三队编成 ───────────────────────────

/** 本地编队草稿（表单状态；保存后才写进存档） */
const draft = ref<(string | null)[][]>(cloneSquads(store.ladderSquads))

watch(
  () => store.ladderSquads,
  (value) => { draft.value = cloneSquads(value) },
  { deep: true },
)

function cloneSquads(src: (string | null)[][]): (string | null)[][] {
  return Array.from({ length: LADDER.SQUAD_COUNT }, (_, s) =>
    Array.from({ length: LADDER.SQUAD_SIZE }, (_, i) => src?.[s]?.[i] ?? null))
}

function heroName(id: string | null): string {
  if (!id) return '空'
  return HERO_INDEX.get(id)?.name ?? id
}

function heroRarity(id: string | null): string {
  if (!id) return ''
  return HERO_INDEX.get(id)?.rarity.toLowerCase() ?? ''
}

/** 选择器 */
const pickerOpen = ref(false)
const pickerSquad = ref(0)
const pickerSlot = ref(0)

function openPicker(squad: number, slot: number) {
  pickerSquad.value = squad
  pickerSlot.value = slot
  pickerOpen.value = true
}

function place(heroId: string) {
  const row = draft.value[pickerSquad.value]
  if (!row) return
  // 同一队内不重复（与 core 的 validateSquad 同一口径）
  if (row.some((id, i) => i !== pickerSlot.value && id === heroId)) {
    store.notify('同一队内不能重复上阵', 'warn')
    return
  }
  row[pickerSlot.value] = heroId
  pickerOpen.value = false
}

function clearSlot(squad: number, slot: number) {
  const row = draft.value[squad]
  if (!row) return
  row[slot] = null
}

/** 用主线编队填满某一队（省事按钮） */
function fillFromMain(squad: number) {
  const row = draft.value[squad]
  if (!row) return
  const main = store.save.team.slots
  for (let i = 0; i < LADDER.SQUAD_SIZE; i++) row[i] = main[i] ?? null
  store.notify(`第 ${squad + 1} 队已按主线编队填入，记得保存`, 'info')
}

const saving = ref(false)
async function saveSquads() {
  saving.value = true
  const res = await store.saveLadderSquads(draft.value)
  saving.value = false
  if (res) store.notify('演武场阵容已保存', 'ok')
}

// ─────────────────────────── 挑战 ───────────────────────────

const challenging = ref(false)
const result = ref<LadderChallengeResult | null>(null)

async function challenge() {
  challenging.value = true
  const res = await store.runLadderChallenge()
  challenging.value = false
  if (!res) return
  result.value = res
  const settlement = res.settlements?.[res.settlements.length - 1]
  store.notify(
    `挑战结束 · ${res.wins}/3 胜 · 段位分 +${res.points}`
    + (settlement ? ` · 赛季 ${settlement.season} 已结算` : ''),
    res.wins >= 3 ? 'ok' : 'info',
  )
}

function squadResult(round: LadderRoundResult, index: number) {
  return round.squads.find((s) => s.index === index)
}

// ─────────────────────────── 回流奖励 ───────────────────────────

async function claimReturn() {
  const res = await store.claimReturnReward()
  if (!res) return
  // ⚠ **实施修正（资源/背包版本 v10）**：回流奖励改发**通用经验书**（`items`），
  //   竞技勋章停发（`medals` 恒为 0）——名称一律取登记表（铁律 #8）。
  const parts = rewardLines(res.rewards).map((l) => `${l.label} +${formatNumber(l.value)}`)
  store.notify(`回流奖励已领取（离线 ${res.days} 天）${parts.length ? ' · ' + parts.join(' · ') : ''}`, 'ok')
}

/** 敌方梯队里的敌人名 */
function enemyNames(squadId: string): string[] {
  const tier = LADDER_TIERS[tierDef.value.index]
  const def = tier.squads.find((s) => s.id === squadId)
  if (!def) return []
  return def.enemyIds.map((id) => getEnemy(id).name)
}
</script>

<template>
  <div class="page">
    <div class="page-title">演武场</div>

    <!-- 玩法说明 -->
    <section class="panel notice">
      <div class="panel-title"><span>三队天梯</span></div>
      <p class="tiny" style="margin: 0; line-height: 1.8; color: var(--c-text-dim)">
        每轮用 <b>3 支队伍</b>（各 6 人）依次挑战 <b>3 个敌方梯队</b>，每周一轮（周一 0 点重置）。
        本模式按 <b>PVE 完整数值</b>结算——等级、遗物强化、羁绊与永久加成全部生效，
        是检验养成成果的舞台。
      </p>
      <p class="tiny warn-text" style="margin: 8px 0 0; line-height: 1.8">
        敌方梯队为 <b>灵体投影</b>（架空演武设定，非史实对决）。产出只有竞技勋章与竞技材料，
        <b>不回流</b>银两 / 经验 / 强化石 / 圣杯结晶。
      </p>
    </section>

    <!-- 我的天梯 -->
    <section class="panel">
      <div class="panel-title">
        <span>我的天梯</span>
        <button class="btn btn-sm btn-ghost" @click="router.push('/arena')">竞技场 ›</button>
      </div>
      <div class="grid-3">
        <div class="metric">
          <div class="tiny muted">段位</div>
          <div class="metric-num gold">{{ store.ladderTier }}</div>
        </div>
        <div class="metric">
          <div class="tiny muted">段位分</div>
          <div class="metric-num">{{ formatNumber(arena.tierPoints) }}</div>
        </div>
        <div class="metric">
          <div class="tiny muted">竞技勋章</div>
          <div class="metric-num">{{ formatNumber(arena.medals) }}</div>
        </div>
      </div>
      <div class="row-between tiny" style="margin-top: 10px">
        <span class="muted">赛季</span>
        <b>第 {{ ladder.season || 1 }} 赛季 · 赛季积分 {{ formatNumber(ladder.seasonPoints) }}</b>
      </div>
      <div class="row-between tiny">
        <span class="muted">本周状态</span>
        <b>{{ settled ? '已挑战（周一 0 点重置）' : '可挑战' }}</b>
      </div>
      <div class="row-between tiny">
        <span class="muted">竞技材料</span>
        <b>{{ formatNumber(arena.arenaMaterials ?? 0) }}</b>
      </div>
      <div v-if="ladder.seasonTitles.length" class="row-between tiny">
        <span class="muted">已获称号</span>
        <b>{{ ladder.seasonTitles.length }} 个</b>
      </div>
    </section>

    <!-- 回流奖励 -->
    <section v-if="store.returnPending" class="panel return">
      <div class="panel-title"><span>回流奖励</span></div>
      <p class="tiny" style="margin: 0; line-height: 1.8">
        离线 {{ ladder.returnDays }} 天，欢迎回来！可领取通用经验书与竞技勋章。
      </p>
      <button
        class="btn btn-primary btn-block"
        style="margin-top: 8px"
        data-testid="ladder-claim-return"
        @click="claimReturn"
      >
        领取回流奖励
      </button>
    </section>

    <!-- 三队编成 -->
    <section class="panel">
      <div class="panel-title">
        <span>三队编成</span>
        <span class="tiny muted">每队 {{ LADDER.SQUAD_SIZE }} 人 · 允许跨队复用英灵</span>
      </div>
      <div v-for="(_, s) in LADDER.SQUAD_COUNT" :key="s" class="squad">
        <div class="row-between" style="margin-bottom: 6px">
          <b class="tiny">第 {{ s + 1 }} 队 → 梯队 {{ s + 1 }}</b>
          <button class="btn btn-sm btn-ghost" @click="fillFromMain(s)">按主线填充</button>
        </div>
        <div class="slot-grid">
          <button
            v-for="i in LADDER.SQUAD_SIZE"
            :key="i"
            class="slot"
            :class="{ filled: !!draft[s]?.[i - 1] }"
            :data-testid="`ladder-slot-${s}-${i - 1}`"
            @click="openPicker(s, i - 1)"
          >
            <span v-if="!draft[s]?.[i - 1]" class="slot-empty">空位 {{ i }}</span>
            <template v-else>
              <img
                :src="HERO_INDEX.get(draft[s][i - 1]!)?.portrait"
                class="portrait"
                :class="`portrait-${heroRarity(draft[s][i - 1])}`"
                width="100%"
                height="100%"
                loading="lazy"
              />
              <span class="slot-name">{{ heroName(draft[s]?.[i - 1] ?? null) }}</span>
            </template>
          </button>
        </div>
      </div>
      <button
        class="btn btn-block"
        style="margin-top: 10px"
        data-testid="ladder-save"
        :disabled="saving"
        @click="saveSquads"
      >
        保存阵容
      </button>
      <p class="tiny muted" style="margin: 6px 0 0">
        同一队内不能重复上阵；跨队复用同一名英灵是允许的（实测三支独立队伍的边际收益不明显）。
      </p>
    </section>

    <!-- 敌方梯队 -->
    <section class="panel">
      <div class="panel-title">
        <span>敌方梯队 · {{ tierDef.name }}</span>
        <span class="tiny muted">第 {{ tierIndex + 1 }} 层</span>
      </div>
      <div v-for="(sq, idx) in tierDef.squads" :key="sq.id" class="enemy-row">
        <div class="row-between tiny">
          <b>梯队 {{ idx + 1 }} · {{ sq.name }}</b>
          <span class="muted">{{ enemyNames(sq.id).length }} 名灵体</span>
        </div>
        <div class="tiny muted" style="margin-top: 2px">{{ enemyNames(sq.id).join(' · ') }}</div>
      </div>
    </section>

    <!-- 挑战 -->
    <section class="panel">
      <div class="panel-title"><span>发起挑战</span></div>
      <button
        class="btn btn-primary btn-block"
        data-testid="ladder-challenge"
        :disabled="challenging || settled"
        @click="challenge"
      >
        {{ settled ? '本周已挑战' : '开始挑战（3 队 × 3 梯队）' }}
      </button>
      <p class="tiny muted" style="margin: 6px 0 0">每周一轮；三个梯队全胜可拿登顶奖励。</p>
    </section>

    <!-- 挑战结果 -->
    <section v-if="result" class="panel" data-testid="ladder-result">
      <div class="panel-title">
        <span>挑战结果</span>
        <span class="tag" :class="result.wins >= 3 ? 'tag-sr' : ''">{{ result.wins }} / 3 胜</span>
      </div>
      <div v-for="(sq, idx) in result.squads" :key="sq.index" class="enemy-row">
        <div class="row-between tiny">
          <b>{{ sq.enemySquadName }}</b>
          <span class="tag" :class="sq.win ? 'tag-sr' : ''">{{ sq.win ? '胜利' : '失败' }}</span>
        </div>
        <div class="tiny muted" style="margin-top: 2px">
          回合 {{ sq.result.rounds }} · 我方存活 {{ sq.result.survivors.length }} 人
        </div>
      </div>
      <div class="row-between tiny" style="margin-top: 8px">
        <span class="muted">段位分</span>
        <b class="ok-text">+{{ result.points }}</b>
      </div>
      <div class="row-between tiny">
        <span class="muted">竞技勋章</span>
        <b>+{{ result.reward.medals }}</b>
      </div>
      <div class="row-between tiny">
        <span class="muted">竞技材料</span>
        <b>+{{ result.reward.arenaMaterials }}</b>
      </div>
      <div v-for="s in result.settlements" :key="s.season" class="season-note tiny">
        赛季 {{ s.season }} 结算 · 赛季积分 {{ s.seasonPoints }} · 勋章 +{{ s.medals }}
        · 竞技材料 +{{ s.arenaMaterials }} · 段位分保留 {{ s.carryPoints }} / {{ s.tierPointsBefore }}
      </div>
    </section>

    <!-- 英灵选择器 -->
    <div v-if="pickerOpen" class="mask" @click.self="pickerOpen = false">
      <div class="dialog">
        <div class="panel-title">
          <span>第 {{ pickerSquad + 1 }} 队 · 第 {{ pickerSlot + 1 }} 槽</span>
          <button class="btn btn-sm btn-ghost" @click="pickerOpen = false">关闭</button>
        </div>
        <div v-if="store.ownedHeroes.length === 0" class="empty">尚未拥有英灵</div>
        <button
          v-for="hero in store.ownedHeroes"
          :key="hero.id"
          class="list-item pick-row"
          @click="place(hero.id)"
        >
          <img
            :src="hero.portrait"
            class="portrait"
            :class="`portrait-${hero.rarity.toLowerCase()}`"
            width="40"
            height="40"
            loading="lazy"
          />
          <div style="flex: 1; min-width: 0">
            <div class="row" style="gap: 6px">
              <b>{{ hero.name }}</b>
              <span class="tiny muted">{{ hero.role }}</span>
              <span class="tiny" :class="`el-${hero.element}`">{{ hero.element }}</span>
            </div>
            <div class="tiny muted">Lv{{ store.save.heroes[hero.id]?.level ?? 1 }}</div>
          </div>
        </button>
        <button
          v-if="draft[pickerSquad]?.[pickerSlot]"
          class="btn btn-sm btn-danger btn-block"
          style="margin-top: 8px"
          @click="clearSlot(pickerSquad, pickerSlot)"
        >
          清空第 {{ pickerSlot + 1 }} 槽（{{ heroName(draft[pickerSquad][pickerSlot]) }}）
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.notice {
  border-color: #6b5a2c;
}

.return {
  border-color: var(--c-gold);
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

.squad {
  padding: 8px 0;
  border-bottom: 1px solid var(--c-line);
}

.slot-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
}

.slot {
  position: relative;
  aspect-ratio: 3 / 4;
  border-radius: 8px;
  border: 1px dashed var(--c-line-2);
  background: var(--c-bg-2);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  padding: 0;
}

.slot.filled {
  border-style: solid;
  border-color: var(--c-gold);
}

.slot .portrait {
  border-radius: 0;
  border: none;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.slot-empty {
  font-size: 11px;
  color: var(--c-text-mute);
}

.slot-name {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 2px 0;
  text-align: center;
  font-size: 10px;
  color: #fdf4dd;
  background: rgba(20, 18, 15, 0.78);
}

.enemy-row {
  padding: 6px 0;
  border-bottom: 1px solid var(--c-line);
}

.enemy-row:last-child {
  border-bottom: none;
}

.season-note {
  margin-top: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--c-bg-2);
  color: var(--c-gold-2);
  line-height: 1.7;
}

.pick-row {
  width: 100%;
  text-align: left;
}
</style>
