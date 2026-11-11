/**
 * 卡面「可读文字」裁定（Phase 8b 补充）。
 *
 * focus-check 问的是「有没有类似符文的笔画」，这个标准会把
 * 饕餮纹、团花纹、法阵、兵法阵图一并判成「有文字」，误报率高。
 *
 * 本脚本只问一个更窄、可判定的问题：
 *   画面里有没有**能读出具体字词的文字**（像读出「商鞅」「变法」这种）？
 * 纯装饰纹样、几何图案、法阵、光效都不算。
 *
 * 用法：npx tsx tools/artgen/tiebreak.ts <heroId...>
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AI_CARD_EXT } from '../../src/core/config/art.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const OUT = join(ROOT, 'tools/artgen/out')

const ids = process.argv.slice(2)
if (ids.length === 0) {
  console.error('用法：npx tsx tools/artgen/tiebreak.ts <heroId...>')
  process.exit(1)
}

const TIEBREAK_PROMPT = [
  '这是一张游戏角色卡面。请只判断一件事：',
  '',
  '画面中是否存在**可以读出具体字词**的文字？',
  '——像能读出「某两个字」「某一句话」这种，才算文字。',
  '',
  '以下**不算**文字：',
  '· 纯装饰纹样（云纹、饕餮纹、卷草纹、回纹、团花纹）',
  '· 几何图案、法阵、星图、罗盘刻度、棋盘格',
  '· 模糊的刻痕、划痕、金属拉丝、织物纹理',
  '· 笔画不像任何具体字符的抽象符号',
  '',
  '如果画面里只有装饰纹样而没有可读字词，答案就是「无」。',
  '',
  '请严格按下面两行格式回答，不要附加分析：',
  '文字.无',
  '文字.有（写出的具体字词）',
].join('\n')

function runCli(args: string[]): string {
  const cmd = ['mcode-tools', ...args]
    .map((a) => (/[\s"^&|<>]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(' ')
  return execFileSync(cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: true })
}

const image_info = ids.map((id) => {
  const file = join(ROOT, 'public/portraits', `${id}${AI_CARD_EXT}`)
  const parsed = JSON.parse(runCli(['upload_temp_url', file])) as { temp_url?: string; url?: string }
  const url = parsed.temp_url ?? parsed.url
  if (!url) throw new Error(`${id} 无法取得可访问地址`)
  return { url, mime_type: 'image/webp', prompt: TIEBREAK_PROMPT }
})

const argsFile = join(OUT, 'tiebreak-args.json')
writeFileSync(argsFile, JSON.stringify({ image_info }, null, 2), 'utf8')

const raw = execFileSync(
  `mcode-tools connector call connector__matrix__describe_images --args-file "${argsFile}"`,
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: true },
)
writeFileSync(join(OUT, 'tiebreak.json'), raw, 'utf8')

const parsed = JSON.parse(raw) as { results?: { success: boolean; description: string }[] }
;(parsed.results ?? []).forEach((r, i) => {
  const id = ids[i] ?? `#${i + 1}`
  console.log(`${id.padEnd(14)} ${(r.description ?? '').replace(/\s+/g, ' ').trim()}`)
})
