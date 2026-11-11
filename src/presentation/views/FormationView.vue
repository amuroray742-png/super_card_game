<script setup lang="ts">
/**
 * 阵位：6 槽编队（前排 3 / 后排 3）、羁绊与预设编队。
 * 战力与羁绊状态一律取 store（core 计算），组件不自行判定。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useGameStore } from '../stores/game'
import { FRONT_SLOTS, TEAM_SIZE, preferredSlotForRole, slotKind } from '../../core/systems/team.ts'
import { formatPower } from '../utils/format'
import type { HeroDef } from '../../core/model/types.ts'

const store = useGameStore()
const router = useRouter()

/** 槽位下标 */
const slots = computed(() => Array.from({ length: TEAM_SIZE }, (_, i) => i))
const frontSlots = computed(() => slots.value.filter((i) => slotKind(i) === 'front'))
const backSlots = computed(() => slots.value.filter((i) => slotKind(i) === 'back'))

/** 槽位内的英灵 */
function heroOf(index: number): HeroDef | null {
  const id = store.save.team.slots[index]
  if (!id) return null
  return store.ownedHeroes.find((h) => h.id === id) ?? null
}

/** 英灵选择器 */
const pickerOpen = ref(false)
const pickerSlot = ref(0)

function openPicker(index: number) {
  pickerSlot.value = index
  pickerOpen.value = true
}

function place(heroId: string) {
  store.setSlot(pickerSlot.value, heroId)
  pickerOpen.value = false
}

function clearSlot(index: number) {
  store.setSlot(index, null)
}

/** 预设编队 */
const presetName = ref('')

function savePreset() {
  const name = presetName.value.trim()
  if (!name) {
    store.notify('请先填写预设名称', 'warn')
    return
  }
  store.savePreset(name)
  presetName.value = ''
}

function applyPreset(id: string) {
  store.applyPreset(id)
  store.notify('已应用预设', 'ok')
}

function removePreset(id: string) {
  store.removePreset(id)
}

/** 该英灵当前是否已在编队中 */
function placedIndex(heroId: string): number {
  return store.save.team.slots.indexOf(heroId)
}
</script>

<template>
  <div class="page">
    <div class="page-title">阵位</div>

    <!-- 总览 -->
    <section class="panel">
      <div class="row-between">
        <div class="tiny muted">编队总战力</div>
        <div class="power">{{ formatPower(store.teamPower) }}</div>
      </div>
      <div class="tiny muted" style="margin-top: 4px">
        已上阵 {{ store.save.team.slots.filter(Boolean).length }} / {{ TEAM_SIZE }}
      </div>
    </section>

    <!-- 前排 -->
    <section class="panel">
      <div class="panel-title">
        <span>前排</span>
        <span class="tiny muted">{{ FRONT_SLOTS }} 槽 · 承伤</span>
      </div>
      <div class="slot-grid">
        <button v-for="i in frontSlots" :key="i" class="slot" :class="{ filled: !!heroOf(i) }" @click="openPicker(i)">
          <img
            v-if="heroOf(i)"
            :src="heroOf(i)?.portrait"
            class="portrait"
            :class="`portrait-${heroOf(i)?.rarity.toLowerCase()}`"
            width="100%"
            height="100%"
            loading="lazy"
          />
          <span v-else class="slot-empty">空位 {{ i + 1 }}</span>
          <span v-if="heroOf(i)" class="slot-name">{{ heroOf(i)?.name }}</span>
        </button>
      </div>
    </section>

    <!-- 后排 -->
    <section class="panel">
      <div class="panel-title">
        <span>后排</span>
        <span class="tiny muted">{{ TEAM_SIZE - FRONT_SLOTS }} 槽 · 输出</span>
      </div>
      <div class="slot-grid">
        <button v-for="i in backSlots" :key="i" class="slot" :class="{ filled: !!heroOf(i) }" @click="openPicker(i)">
          <img
            v-if="heroOf(i)"
            :src="heroOf(i)?.portrait"
            class="portrait"
            :class="`portrait-${heroOf(i)?.rarity.toLowerCase()}`"
            width="100%"
            height="100%"
            loading="lazy"
          />
          <span v-else class="slot-empty">空位 {{ i + 1 }}</span>
          <span v-if="heroOf(i)" class="slot-name">{{ heroOf(i)?.name }}</span>
        </button>
      </div>
    </section>

    <!-- 羁绊 -->
    <section class="panel">
      <div class="panel-title">
        <span>羁绊</span>
        <span class="tiny muted">已激活 {{ store.bondStates.filter((b) => b.active).length }} / {{ store.bondStates.length }}</span>
      </div>
      <div v-if="store.bondStates.length === 0" class="empty" style="padding: 16px">暂无羁绊</div>
      <div v-for="b in store.bondStates" :key="b.bond.id" class="bond">
        <div class="row-between">
          <b :class="{ dim: !b.active }">{{ b.bond.name }}</b>
          <span class="tag" :class="b.active ? 'tag-sr' : ''">
            {{ b.active ? '已激活' : `${b.count}` }}
          </span>
        </div>
        <div class="tiny muted" style="margin-top: 3px">{{ b.bond.desc }}</div>
        <div v-for="(e, i) in b.bond.effects" :key="i" class="tiny effect">· {{ e.desc }}</div>
      </div>
    </section>

    <!-- 预设编队 -->
    <section class="panel">
      <div class="panel-title">
        <span>预设编队</span>
        <span class="tiny muted">{{ store.save.team.presets.length }} 套</span>
      </div>
      <div class="row" style="gap: 6px">
        <input v-model="presetName" class="preset-input" placeholder="预设名称" />
        <button class="btn btn-sm" @click="savePreset">保存</button>
      </div>
      <div v-if="store.save.team.presets.length === 0" class="tiny muted" style="margin-top: 8px">
        尚未保存预设编队。
      </div>
      <div v-for="p in store.save.team.presets" :key="p.id" class="list-item" style="margin-top: 6px">
        <div style="flex: 1; min-width: 0">
          <div>{{ p.name }}</div>
          <div class="tiny muted">
            {{ p.slots.filter(Boolean).length }} / {{ TEAM_SIZE }} 槽
          </div>
        </div>
        <button class="btn btn-sm" @click="applyPreset(p.id)">应用</button>
        <button class="btn btn-sm btn-danger" @click="removePreset(p.id)">删除</button>
      </div>
    </section>

    <button class="btn btn-block btn-ghost" @click="router.push('/expedition')">前往推征</button>

    <!-- 英灵选择器 -->
    <div v-if="pickerOpen" class="mask" @click.self="pickerOpen = false">
      <div class="dialog">
        <div class="panel-title">
          <span>选择英灵 · 第 {{ pickerSlot + 1 }} 槽（{{ slotKind(pickerSlot) === 'front' ? '前排' : '后排' }}）</span>
          <button class="btn btn-sm btn-ghost" @click="pickerOpen = false">关闭</button>
        </div>
        <div v-if="store.ownedHeroes.length === 0" class="empty">尚未拥有英灵</div>
        <button v-for="hero in store.ownedHeroes" :key="hero.id" class="list-item pick-row" @click="place(hero.id)">
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
            <div class="tiny muted">
              Lv{{ store.save.heroes[hero.id]?.level ?? 1 }} · 推荐{{
                preferredSlotForRole(hero.role) === 'front' ? '前排' : '后排'
              }}
            </div>
          </div>
          <span v-if="placedIndex(hero.id) >= 0" class="tiny muted">已上阵</span>
        </button>
        <button
          v-if="heroOf(pickerSlot)"
          class="btn btn-sm btn-danger btn-block"
          style="margin-top: 8px"
          @click="clearSlot(pickerSlot)"
        >
          清空第 {{ pickerSlot + 1 }} 槽（{{ heroOf(pickerSlot)?.name }}）
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.power {
  font-size: 24px;
  font-weight: 700;
  color: var(--c-gold-2);
}

.slot-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.slot {
  position: relative;
  aspect-ratio: 3 / 4;
  border-radius: 10px;
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
  font-size: 12px;
  color: var(--c-text-mute);
}

.slot-name {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 3px 0;
  text-align: center;
  font-size: 11px;
  color: #fdf4dd;
  background: rgba(20, 18, 15, 0.78);
}

.bond {
  padding: 7px 0;
  border-bottom: 1px solid var(--c-line);
}

.bond:last-child {
  border-bottom: none;
}

.effect {
  color: var(--c-text-mute);
  margin-top: 2px;
}

.dim {
  color: var(--c-text-mute);
}

.preset-input {
  flex: 1;
  min-width: 0;
  padding: 9px 12px;
  border-radius: 8px;
  border: 1px solid var(--c-line);
  background: var(--c-bg-2);
  outline: none;
}

.preset-input:focus {
  border-color: var(--c-line-2);
}

.pick-row {
  width: 100%;
  text-align: left;
}
</style>
