/**
 * 抑制 Node 内置 `node:sqlite` 的实验性警告，保持测试输出干净。
 *
 * 只过滤这一条，其余警告照常输出，不做全局静音。
 */
const original = process.emitWarning

process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const text = typeof warning === 'string' ? warning : (warning?.message ?? '')
  if (text.includes('SQLite is an experimental feature')) return
  ;(original as (...rest: unknown[]) => void)(warning, ...args)
}) as typeof process.emitWarning
