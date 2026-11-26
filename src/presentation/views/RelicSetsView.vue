<script setup lang="ts">
/**
 * **套装与保底**（L2 二级页，背包页 v14 一屏化）。
 *
 * ## 为什么拆出来
 *
 * 遗物分类原来把三块**参考信息**全堆在仓库上方：
 * 套装进度（12 行）、保底进度（6 变体 × 3 关卡 = 18 行）、套装效果（12 组档位）。
 * 三块加起来 ≈ 2160px，而 360×640 机型的内容区只有 534px ——
 * 于是**真正的仓库网格被挤到第 3 屏以下**，「点一件遗物 → 强化」的按钮
 * 排在 1760px 的网格**下面**，手机上要滚 3 屏才摸得到。
 *
 * 现在：
 * - L1（背包）只留**一行摘要**（套装成型数 + 保底还差几件）⇒ 铁律 #27 仍成立；
 * - 三块参考信息合并进这一个二级页 ⇒ 深度 2（≤ 3）。
 *
 * ## 口径（全部来自 core / 服务端，表现层不自己数）
 *
 * - 套装件数 → `store.relicSetCounts`（**服务端统计**；客户端镜像里只有已装备件）；
 * - 每套装总件数 → core 的 `relicIdsBySet`；
 * - 套装档位与描述 → core 的 `RELIC_SETS[].bonuses`（**不硬编码 2/4/6**）；
 * - 编队生效件数 → core 的 `getSetModsBySetIds`（与仓库、图鉴**同一份**）；
 * - 保底 → core 的 `RELIC_DROP.PITY_SSR` − 存档里的 `relicPity[stageId]`；
 * - 套装 → 副本的映射 → core 的 `findRelicDungeonVariant`（**唯一一份**）。
 */
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useGameStore } from '../stores/game'
import {
  RELIC_DEFS,
  RELIC_SETS,
  getSetModsBySetIds,
  relicQuotaLeft,
} from '../../core/systems/relic.ts'
import { relicIdsBySet } from '../../core/config/relics.ts'
import {
  DUNGEON_INDEX,
  DUNGEON_VARIANT_ORDER,
  dungeonStagesOfVariant,
  findRelicDungeonVariant,
  type DungeonVariant,
} from '../../core/config/dungeons.ts'
import { RELIC_DROP } from '../../core/config/economy.ts'
import { formatNumber } from '../utils/format'

const store = useGameStore()
const router = useRouter()

/** 套装表（配置口径，固定 12 套） */
const sets = computed(() => [...RELIC_SETS.values()])

/** 遗物副本变体（遗物的唯一来源，6 个） */
const relicVariants = computed<DungeonVariant[]>(() =>
  DUNGEON_VARIANT_ORDER.map((id) => DUNGEON_INDEX.get(id))
    .filter((v): v is DungeonVariant => !!v && v.kind === 'relic'),
)

/** 仓库里某套装已有几件（**服务端口径**） */
function setCountOf(setId: string): number {
  return store.relicSetCounts.get(setId) ?? 0
}

/** 某套装共有几件（配置口径） */
function setTotalOf(setId: string): number {
  return relicIdsBySet(setId).length
}

/** 某套装由哪个遗物副本产出（core 独家映射） */
function dungeonNameOf(setId: string): string {
  return findRelicDungeonVariant(setId)?.name ?? '—'
}

/**
 * 点套装 → **直达产出它的遗物副本**。
 *
 * ⚠ 深链参数用 `?relic=<setId>`：副本页拿到它就高亮那个副本。
 * ⚠ 入口必须**真的可达**（铁律 #10）：点了就要落到能拿到这件遗物的关卡上。
 */
function goDungeonOfSet(setId: string) {
  const variant = findRelicDungeonVariant(setId)
  if (!variant) {
    store.notify('该套装暂时没有对应副本', 'warn')
    return
  }
  void router.push({ path: '/dungeon', query: { kind: 'relic', relic: setId } })
}

/** 某关卡的保底计数（连续未出 SSR 的**件数**，随存档落盘） */
function pityOf(stageId: string): number {
  return store.save.relicPity[stageId] ?? 0
}

/** 还差几件必出 SSR */
function pityRemain(stageId: string): number {
  return Math.max(0, RELIC_DROP.PITY_SSR - pityOf(stageId))
}

/** 某变体的关卡列表 */
function stagesOf(variantId: string) {
  return dungeonStagesOfVariant(variantId as never)
}

// ─────────────────────────── 编队生效件数 ───────────────────────────

/**
 * 当前编队已装备的套装 id 列表（空槽位记 `null`）。
 *
 * ⚠ 客户端镜像里**只有已装备的遗物**（仓库走服务端分页），
 *   所以这里只数编队里的 —— 不拿它冒充「仓库里有多少件可凑套装」。
 */
const teamSetIds = computed<(string | null)[]>(() => {
  const out: (string | null)[] = []
  for (const hero of store.team) {
    const slots = store.equippedMap.get(hero.def.id) ?? []
    for (const r of slots) {
      if (!r) {
        out.push(null)
        continue
      }
      const d = RELIC_DEFS.get(r.defId)
      out.push(d ? d.setId : null)
    }
  }
  return out
})

/** 编队当前生效的套装加成（**core 独家口径**） */
const teamSetMods = computed(() => getSetModsBySetIds(teamSetIds.value))

/** 某套装在编队中的件数 */
function teamCountOf(setId: string): number {
  return teamSetIds.value.filter((id) => id === setId).length
}

/**
 * 今日剩余遗物额度（件）。
 *
 * ⚠ 走 core 的 `relicQuotaLeft`（**唯一一份**，按 UTC 日期键判定）；
 *   时间取**注入时钟** `store.now()`，禁止 `Date.now()`（铁律 #12）。
 */
const quotaLeft = computed(() => relicQuotaLeft(store.save, store.now()))

onMounted(() => {
  // 套装件数来自**服务端统计**（客户端镜像里只有已装备件）⇒ 进页面拉一次
  void store.loadRelicStats()
  // 刷新一次存档镜像：保底计数住在存档里，
  // 另一条链路刚打过副本的话，镜像里的计数是旧的 ⇒ 玩家看到过期的保底进度。
  void store.refreshSave()
})
</script>

<template>
  <div class="page">
    <div class="page-title">套装与保底</div>

    <!-- 套装（进度 + 档位合一：两者都遍历 12 个套装，分成两块等于把 24 行摆一页） -->
    <section class="panel">
      <div class="panel-title">
        <span>套装</span>
        <span class="tiny muted">点套装 → 去对应副本</span>
      </div>
      <div v-for="set in sets" :key="set.id" class="set-block">
        <button
          class="set-row"
          :data-testid="`relic-set-row-${set.id}`"
          @click="goDungeonOfSet(set.id)"
        >
          <span class="set-row-name">{{ set.name }}</span>
          <span class="tiny muted">{{ setCountOf(set.id) }} / {{ setTotalOf(set.id) }} 件</span>
          <span class="tiny muted set-row-dungeon">产出副本：{{ dungeonNameOf(set.id) }}</span>
        </button>
        <div class="tiny muted set-desc">{{ set.desc }}</div>
        <div
          v-for="bonus in set.bonuses"
          :key="bonus.pieces"
          class="row-between tiny bonus-row"
        >
          <span class="muted">{{ bonus.pieces }} 件</span>
          <span>
            {{ bonus.desc }}
            <span class="tag" :class="teamCountOf(set.id) >= bonus.pieces ? 'tag-sr' : ''">
              {{ teamCountOf(set.id) >= bonus.pieces ? '生效' : '未生效' }}
            </span>
          </span>
        </div>
      </div>
    </section>

    <!-- 保底进度（各遗物副本关卡） -->
    <section class="panel">
      <div class="panel-title">
        <span>保底进度</span>
        <span class="tiny muted">连续 {{ RELIC_DROP.PITY_SSR }} 件未出 SSR 必出</span>
      </div>
      <div v-for="variant in relicVariants" :key="variant.id" class="pity-block">
        <div class="tiny muted pity-variant">{{ variant.name }}</div>
        <div
          v-for="stage in stagesOf(variant.id)"
          :key="stage.id"
          class="row-between tiny pity-row"
          :data-testid="`relic-pity-row-${stage.id}`"
        >
          <span>{{ stage.name }}</span>
          <span class="muted">再 {{ pityRemain(stage.id) }} 件必出 SSR</span>
        </div>
      </div>
      <p class="tiny muted" style="margin: 8px 0 0">
        今日剩余遗物额度 {{ quotaLeft }} 件 · 手动挑战遗物副本不受额度限制
      </p>
    </section>

    <!-- 套装效果：编队当前生效几项（**core 独家口径**） -->
    <section class="panel">
      <div class="panel-title">
        <span>套装效果</span>
        <span class="tiny muted">编队生效 {{ teamSetMods.length }} 项</span>
      </div>
      <p class="tiny muted" style="margin: 0">
        套装加成按<b>装备件数</b>阶梯生效：上面的「生效 / 未生效」标记按当前编队实时判定。
      </p>
    </section>
  </div>
</template>

<style scoped>
.set-block {
  padding: 8px 0;
  border-bottom: 1px solid var(--c-line);
}

.set-block:last-child {
  border-bottom: none;
}

/* 套装进度行（可点击 → 直达产出它的遗物副本） */
.set-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  width: 100%;
  padding: 6px 0;
  text-align: left;
  border-bottom: 1px solid var(--c-line);
}

.set-row:last-child {
  border-bottom: none;
}

.set-row-name {
  font-size: 13px;
  color: var(--c-text);
}

.set-row-dungeon {
  flex-basis: 100%;
}

.set-desc {
  margin: 2px 0 4px;
}

.bonus-row {
  padding: 3px 0;
}

/* 保底进度（每个遗物副本一组） */
.pity-block {
  padding: 6px 0;
  border-bottom: 1px solid var(--c-line);
}

.pity-block:last-child {
  border-bottom: none;
}

.pity-variant {
  margin-bottom: 2px;
}

.pity-row {
  padding: 1px 0;
}
</style>
