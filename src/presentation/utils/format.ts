/**
 * 展示层格式化工具（纯函数，不含规则判断）。
 *
 * 单一数据源：实现已下沉到 `src/core/utils/format.ts`
 * （动作层在 core 里生成提示文案，必须与界面显示用同一套格式化口径），
 * 这里只做再导出，避免两处各写一套。
 */
export {
  formatNumber,
  formatRate,
  formatPower,
  percent,
  formatDuration,
} from '../../core/utils/format.ts'
