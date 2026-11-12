<script setup lang="ts">
/**
 * 合规与概率公示。
 *
 * 本页所有概率数据取自 store.rates（core 的 computeEffectiveRates），
 * 与实际抽卡同源；文案不含绝对化用语与诱导性表述。
 */
import { computed } from 'vue'
import { useGameStore } from '../stores/game'
import { GACHA } from '../../core/config/economy.ts'
import { POOLS } from '../../core/config/pools.ts'
import { formatRate } from '../utils/format'

const store = useGameStore()

/** 逐卡池的概率公示（不同卡池收录范围不同，概率也不同，必须分别公示） */
const poolRates = computed(() =>
  POOLS.map((pool) => ({
    pool,
    rates: store.ratesForPool(pool.id),
  })),
)
</script>

<template>
  <div class="page">
    <div class="page-title">合规与概率公示</div>

    <!-- 1. 概率公示 -->
    <section class="panel">
      <div class="panel-title">
        <span>一、召唤概率公示</span>
        <span class="tiny muted">精确动态规划计算</span>
      </div>
      <div v-for="entry in poolRates" :key="entry.pool.id" class="pool-rate">
        <div class="pool-rate-title">
          {{ entry.pool.name }}
          <span class="tiny muted">{{ entry.pool.heroIds.length || entry.rates.rows.filter((r) => r.inPool).length }} 项收录</span>
        </div>
        <table class="rate-table">
          <thead>
            <tr>
              <th>稀有度</th>
              <th>基础概率</th>
              <th>综合概率</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in entry.rates.rows" :key="row.rarity" :class="{ out: !row.inPool }">
              <td>
                <span class="tag" :class="`tag-${row.rarity.toLowerCase()}`">{{ row.rarity }}</span>
                <span v-if="!row.inPool" class="tiny muted">（本池未收录）</span>
              </td>
              <td>{{ formatRate(row.baseRate / 100) }}</td>
              <td>{{ formatRate(row.tenPullEffective / 100) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <ul class="notes">
        <li>基础概率为单抽概率，各卡池四档之和均为 100.00 个百分点。</li>
        <li>综合概率指一次十连内至少出现 1 次该稀有度或更高品质的概率。</li>
        <li>综合概率由<b>精确动态规划</b>求解，与实际召唤使用同一套概率函数，不含模拟误差。</li>
        <li>十连保底规则保证十连内至少出现 1 个 {{ GACHA.TEN_PULL_FLOOR }} 及以上品质，故对应行显示 100.00 个百分点。</li>
        <li>本池未收录的稀有度，其概率并入本池最低稀有度，故对应行显示 0.00%。</li>
        <li>本页数值随当前保底进度实时刷新，抽取结果以实际结算为准。</li>
      </ul>
    </section>

    <!-- 2. 保底规则 -->
    <section class="panel">
      <div class="panel-title"><span>二、保底规则</span></div>
      <ul class="notes">
        <li>大保底上限：{{ store.rates.pityMax }} 抽。保底计数达到上限后，下一抽由保底规则直接结算为 SSR 品质。</li>
        <li>软保底起点：第 {{ store.rates.softPityStart }} 抽起，SSR 概率随保底计数线性提升。</li>
        <li>十连保底：一次十连内若未出现 {{ GACHA.TEN_PULL_FLOOR }} 及以上品质，最后一抽由保底规则结算。</li>
        <li>保底计数跨卡池继承，在各卡池之间共用同一份计数，不会因切换卡池而重置。</li>
        <li>当前保底进度：距保底结算还差 {{ store.rates.pityRemaining }} 抽。</li>
      </ul>
    </section>

    <!-- 3. 重复获取 -->
    <section class="panel">
      <div class="panel-title"><span>三、重复获取规则</span></div>
      <ul class="notes">
        <li><b>重复英灵不直接提升强度</b>，统一转化为通用英灵印记。</li>
        <li>重复获得的英灵按品质折算印记：SSR {{ GACHA.DUPLICATE_EMBLEM.SSR }} · SR
          {{ GACHA.DUPLICATE_EMBLEM.SR }} · R {{ GACHA.DUPLICATE_EMBLEM.R }} · N
          {{ GACHA.DUPLICATE_EMBLEM.N }}。</li>
        <li>重复的 SSR 另附同名碎片 {{ GACHA.DUPLICATE_SSR_SHARDS }}，重复的 N 另附银两
          {{ GACHA.DUPLICATE_N_SILVER }}。</li>
        <li>星级提升需要同名碎片与印记，属于独立养成路线，重复召唤本身不提升星级或等级。</li>
      </ul>
    </section>

    <!-- 4. 竞技场产出隔离 -->
    <section class="panel">
      <div class="panel-title"><span>四、竞技场产出隔离</span></div>
      <ul class="notes">
        <li>竞技场只产出竞技专属资源（竞技勋章、竞技材料、兑换券）。</li>
        <li>竞技场<b>不产出银两、经验、强化石、圣杯结晶</b>，产出不会回流主线养成经济。</li>
        <li>竞技对战使用归一化规则：单位属性按定位模板重置，等级、遗物强化等级、遗物随机词条与永久加成不参与计算。</li>
        <li>竞技勋章设有每周获取上限，避免竞技产出影响整体养成节奏。</li>
      </ul>
    </section>

    <!-- 5. 付费与广告 -->
    <section class="panel">
      <div class="panel-title"><span>五、付费与广告</span></div>
      <ul class="notes">
        <li>首发版本不提供真实货币充值入口，也没有内购项目。</li>
        <li>首发版本不接入广告 SDK，不展示任何广告内容。</li>
        <li>平台层仅预留支付与广告适配接口，便于后续按需接入。</li>
      </ul>
    </section>

    <!-- 6. 账号与数据 -->
    <section class="panel">
      <div class="panel-title"><span>六、账号与数据</span></div>
      <ul class="notes">
        <li>游戏需要玩家自设用户名与口令登录，账号仅用于保存进度，不与真实身份绑定。</li>
        <li>口令以加盐的不可逆哈希形式保存，服务端不保存也不回传口令明文。</li>
        <li>游戏进度随账号保存在服务端，登录同一账号可在其他设备继续；本机同时保留一份副本。</li>
        <li>游戏不采集姓名、联系方式、位置等个人信息，也不收集设备标识。</li>
        <li>玩家可在设置页导出存档串作为备份，也可退出登录或注销账号；注销账号会一并删除该账号的云端存档与登录状态。</li>
        <li>删除账号、退出登录与清空本机存档均可由玩家随时发起，不需要联系客服。</li>
      </ul>
    </section>

    <!-- 7. 适龄提示 -->
    <section class="panel">
      <div class="panel-title"><span>七、适龄提示</span></div>
      <ul class="notes">
        <li>本游戏适合 16 周岁及以上人群游玩。</li>
        <li>请合理安排游戏时间，享受健康生活。</li>
        <li>本游戏不含玩家之间的社交互动、交易与实时对战内容，账号仅用于保存进度。</li>
      </ul>
    </section>

    <!-- 8. 史实说明 -->
    <section class="panel">
      <div class="panel-title"><span>八、史实说明</span></div>
      <ul class="notes">
        <li>英灵原型为史册可考的历史人物，仅作为正面友方形象出现。</li>
        <li>敌对角色全部为虚构的非历史人物形象，由灵体、妖异、幻想体与器械造物构成。</li>
        <li>人物传记仅述史实，不对历史人物作功过评价。</li>
        <li>游戏内的数值、称号与玩法设定均为虚构，不构成对历史记载的改动。</li>
      </ul>
    </section>

    <p class="tiny muted footer-note">
      本页数据来源：{{ store.rates.computation === 'exact-dp' ? '精确动态规划' : '—' }}
    </p>
  </div>
</template>

<style scoped>
.pool-rate {
  margin-bottom: 14px;
}

.pool-rate-title {
  font-size: 12px;
  color: var(--c-gold);
  margin-bottom: 4px;
  display: flex;
  justify-content: space-between;
}

.rate-table tr.out td {
  color: var(--c-text-mute);
  opacity: 0.65;
}

.rate-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.rate-table th {
  font-size: 11px;
  font-weight: 500;
  color: var(--c-text-mute);
  text-align: right;
  padding: 4px 0;
  border-bottom: 1px solid var(--c-line);
}

.rate-table th:first-child,
.rate-table td:first-child {
  text-align: left;
}

.rate-table td {
  text-align: right;
  padding: 5px 0;
  border-bottom: 1px solid var(--c-line);
}

.rate-table tr:last-child td {
  border-bottom: none;
}

.notes {
  margin: 8px 0 0;
  padding-left: 18px;
}

.notes li {
  font-size: 12px;
  line-height: 1.9;
  color: var(--c-text-dim);
  margin-bottom: 2px;
}

.footer-note {
  text-align: center;
  margin: 12px 0 0;
}
</style>
