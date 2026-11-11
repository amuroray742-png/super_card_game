/**
 * 支付适配层 —— 首发为 no-op（不接任何真实支付）。
 *
 * 签名即契约：后续接入真实支付只替换实现，不改业务逻辑。
 */
export interface OrderResult {
  orderId: string
}

export interface PaymentAdapter {
  createOrder(sku: string): Promise<OrderResult>
  verifyReceipt(orderId: string, receipt: string): Promise<{ ok: boolean }>
}

export class NoopPaymentAdapter implements PaymentAdapter {
  async createOrder(_sku: string): Promise<OrderResult> {
    throw new Error('首发版本未接入支付')
  }

  async verifyReceipt(_orderId: string, _receipt: string): Promise<{ ok: boolean }> {
    return { ok: false }
  }
}

export const payment: PaymentAdapter = new NoopPaymentAdapter()
