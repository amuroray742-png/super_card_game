/**
 * 卡面编码（Phase 8b）。
 *
 * 生图产出的是 880×1184 的 JPEG（单张约 350KB），但游戏里卡面最大的展示位是
 * 132×176 CSS px（英灵详情页顶部）。按 4 倍输出宽度即可覆盖 3x 高刷手机的
 * 设备像素，仍留有余量；再高只是白占流量。
 *
 * 因此统一走「降分辨率 + WebP」：
 *   880×1184 JPEG（约 350KB）→ 528×704 WebP（约 49KB），整包 25.9MB → 约 3.4MB。
 *
 * 参数集中在这里，`save-results.ts`（生成即落盘）与 `transcode.ts`（存量批量转码）
 * 共用同一个函数，避免两处各写一套编码规则。
 */
import sharp from 'sharp'

/** 输出宽度（px）。高度按原比例，约 704。 */
export const CARD_WIDTH = 528

/** WebP 有损质量。q82 在 72 张实测中肉眼无损（AI 卡面细节多，再低会糊）。 */
export const CARD_QUALITY = 82

/** 编码 effort，取 6（最高）——离线批处理，一次性成本换更小体积。 */
export const CARD_EFFORT = 6

/**
 * 把原始卡面编码为发布用 WebP。
 * @param input 原始图（生成器下载的 JPEG 字节）
 * @returns WebP 字节
 */
export async function encodeCard(input: Buffer): Promise<Buffer> {
  return sharp(input)
    .resize({ width: CARD_WIDTH })
    .webp({ quality: CARD_QUALITY, effort: CARD_EFFORT })
    .toBuffer()
}
