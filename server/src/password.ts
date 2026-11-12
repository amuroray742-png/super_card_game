/**
 * 口令哈希（Node 内置 scrypt，零第三方依赖）。
 *
 * 存储格式：`scrypt$N$r$p$saltB64$hashB64`
 * - 16 字节随机盐 → 同一口令两次哈希结果不同
 * - 32 字节派生密钥
 * - 比对用 timingSafeEqual，避免时序侧信道
 *
 * ⚠ 口令与哈希都不得出现在任何日志或错误响应里。
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>

/** scrypt 参数：N=16384 时内存约 16MB，在 Node 默认 maxmem 内 */
export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const
const KEY_LENGTH = 32
const SALT_LENGTH = 16

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH)
  const key = await scrypt(password, salt, KEY_LENGTH, { ...SCRYPT_PARAMS })
  return [
    'scrypt',
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$')
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false
  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(parts[4], 'base64')
    expected = Buffer.from(parts[5], 'base64')
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false
  const actual = await scrypt(password, salt, expected.length, { N, r, p })
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}
