/** 旧档迁移的资源边界；不是资产真实性证明（首次无签名资产仍可伪造）。 */
export const SAVE_IMPORT = {
  MAX_ENCODED_CHARS: 700_000,
  MAX_DECODED_BYTES: 500_000,
  MAX_COLLECTION: 2000,
  MAX_TEXT: 256,
} as const
