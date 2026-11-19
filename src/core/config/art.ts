/**
 * 卡面图资源登记表（Phase 8b · AI 生图）。
 *
 * 只登记已由 AI 生图产出卡面的英灵 id；未登记的英灵自动回落到程序化 SVG 占位头像。
 * core 是纯逻辑层，不访问文件系统，因此「某张图是否已产出」在构建期登记于此。
 *
 * AI_CARD_IDS 数组由 `tools/artgen/save-results.ts` 依据生成回执自动回写，请勿手工编辑；
 * 其余部分（资源扩展名、路径函数）手工维护，是 core 与流水线共用的唯一口径。
 */

/**
 * AI 卡面资源扩展名。
 *
 * 流水线产物统一为 WebP（体积约为同画质 JPEG 的 1/3），
 * `tools/artgen/transcode.ts` 与 `save-results.ts` 都从这里取扩展名，避免各写一套。
 */
export const AI_CARD_EXT = '.webp'

/** 已产出 AI 卡面的英灵 id */
export const AI_CARD_IDS: readonly string[] = [
  'alexander',
  'archimedes',
  'aristotle',
  'banchao',
  'banzhao',
  'bianque',
  'bisheng',
  'caesar',
  'cailun',
  'caiwenji',
  'caocao',
  'caodajia',
  'chengjisihan',
  'curie',
  'davinci',
  'direnjie',
  'elizabeth',
  'fankuai',
  'fanli',
  'fuhao',
  'galileo',
  'guoziyi',
  'hanfei',
  'hannibal',
  'hanxin',
  'huangzhong',
  'huatuo',
  'huoqingbing',
  'jeannedarc',
  'libai',
  'libing',
  'liguang',
  'lijing',
  'likui',
  'lishizhen',
  'luban',
  'mayuan',
  'mengtian',
  'nangdengel',
  'napoleon',
  'newton',
  'octave',
  'qijiguang',
  'shangyang',
  'shenkuo',
  'sugeliadi',
  'sunbin',
  'sunwu',
  'suqin',
  'taoyuanming',
  'tesla',
  'tiandan',
  'turing',
  'wangzhaojun',
  'weiqing',
  'wentianxiang',
  'xianfuren',
  'xiangyu',
  'xuanzang',
  'xuxiake',
  'yuanchonghuan',
  'yuchigong',
  'yuefei',
  'zhangfei',
  'zhangheng',
  'zhangliang',
  'zhangqian',
  'zhaoyun',
  'zhenghe',
  'zhouyu',
  'zhugeliang',
  'zuchongzhi',
]

/** 英灵 id 集合，便于 O(1) 查询 */
const AI_CARD_SET = new Set(AI_CARD_IDS)

/**
 * 取英灵立绘路径。
 * @param heroId 英灵 id
 * @returns AI 卡面（WebP）路径；未产出时回落占位头像（SVG）
 */
export function portraitPath(heroId: string): string {
  return AI_CARD_SET.has(heroId)
    ? `/portraits/${heroId}${AI_CARD_EXT}`
    : `/portraits/${heroId}.svg`
}

/**
 * 取敌人立绘路径。
 *
 * 敌人素材按敌人 id 命名（`public/enemies/<id>.svg`），与英灵卡面共用
 * 「路径由 core 给出」的唯一口径（AGENTS.md 铁律 #8）——
 * 表现层不得自行拼接 `/enemies/xxx`。
 *
 * @param defId 敌人**基础定义 id**（名册里的 `defId`，不含 `#序号` 后缀）
 */
export function enemyArtPath(defId: string): string {
  return `/enemies/${defId}.svg`
}

/**
 * 遗物图标资源扩展名。
 *
 * ⚠ 已由程序化 SVG 徽章切换为 **AI 生图 WebP**（`tools/artgen/run-local-icons.ts` 产出）。
 *   - 此前是确定性 SVG 徽章（60 张），只靠「稀有度配色 + 套装几何符号 + 主词条小徽」区分，
 *     **60 件遗物在仓库里长得几乎一样**，玩家认不出哪件是哪件（只能靠解谜反推套装）。
 *   - 现改为 AI 生图：每件遗物按「套装主题 × 器形 × 稀有度」出独立的实物立绘，
 *     认物靠画面本身，不再靠解谜。
 *   - 切换只需改这一处，界面与逻辑都不用动（与英灵卡面同一套路）。
 *
 * 素材由 `npm run art:icons` → `npm run art:icons:run` → `npm run art:icons:publish` 产出，
 * 提示词口径见 `tools/artgen/icon-prompt.ts`（铁律 #45）。
 */
export const RELIC_ICON_EXT = '.webp'

/**
 * 取遗物图标路径。
 *
 * 遗物素材按遗物**基础定义 id** 命名（`public/relics/<defId>.webp`），
 * 与英灵卡面 / 敌人立绘共用「路径由 core 给出」的唯一口径（AGENTS.md 铁律 #8）——
 * 表现层不得自行拼接 `/relics/xxx.webp`。
 *
 * @param defId 遗物定义 id（如 `set_zhanshen_1`）
 */
export function relicIconPath(defId: string): string {
  return `/relics/${defId}${RELIC_ICON_EXT}`
}

/**
 * 资源 / 货币图标资源扩展名。
 *
 * 与卡面（`AI_CARD_EXT`）同走 WebP：体积约为同画质 PNG 的 1/4，
 * 而资源条在每个页面顶部常驻，流量敏感。
 */
export const RESOURCE_ICON_EXT = '.webp'

/**
 * **需要图标的资源 key 全集**（唯一口径）。
 *
 * key 与存档 / 收益包字段一一对应：
 *   `player.silver` / `player.exp` / `player.crystals` / `player.tickets` /
 *   `player.skillStones` / `player.relicStones` / `player.emblems` /
 *   `player.shards` / `arena.medals` / `arena.arenaMaterials`。
 *
 * ⚠ 这份清单是**生图侧与表现层的共同契约**：
 *   生图工具（`tools/artgen/icon-prompt.ts`）按它产出素材，
 *   单元测试按它断言「每个 key 都有图标文件」——
 *   新增资源却忘了出图，会被测试直接拦下（铁律 #22「配置齐全 ≠ 资源齐全」）。
 */
export const RESOURCE_ICON_KEYS = [
  'silver',
  'exp',
  'crystals',
  'tickets',
  'skillStones',
  'relicStones',
  'emblems',
  'shards',
  'medals',
  'arenaMaterials',
] as const

/** 资源 key 类型 */
export type ResourceIconKey = (typeof RESOURCE_ICON_KEYS)[number]

/**
 * 取资源 / 货币图标路径。
 *
 * key 是**数据口径**，不是展示名——表现层拿字段名换图标，
 * 禁止各页面自己拼字符串（AGENTS.md 铁律 #8）。
 *
 * @param key 资源字段名（如 `crystals`）
 */
export function resourceIconPath(key: string): string {
  return `/resources/${key}${RESOURCE_ICON_EXT}`
}

/**
 * 头像裁取约定（§6.3 战斗演出）。
 *
 * 源区是**正方形**：边长 = `sizeRatio × 图片宽度`，水平居中，
 * 顶端偏移 = `topRatio × 图片高度`。
 * 渲染时用 `Image.naturalWidth/Height` 换算，不写死像素，换图不破。
 *
 * - `hero`：卡面是 3:4 全身图，头部落在图高 8%~32%，
 *   取「图宽 50% 的顶部方块」能把头部放进圆内上半（已抽查 xiangyu / caiwenji 验证）。
 * - `enemy`：敌人占位图底部一条是名字文字条（y 424~512），
 *   取 82% 见方并去掉底条，徽记圆环仍完整。
 */
export const AVATAR_CROP = {
  hero: { sizeRatio: 0.5, topRatio: 0.02 },
  enemy: { sizeRatio: 0.82, topRatio: 0 },
} as const
