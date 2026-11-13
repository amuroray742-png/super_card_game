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
