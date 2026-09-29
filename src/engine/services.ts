import type { AiService } from './ai/service'
import type { PriceBook } from './ai/prices'
import type { Providers } from './ai/providers'

/** Module instances that other modules depend on. Built once in boot.ts. */
export type Services = {
  prices: PriceBook
  providers: Providers
  ai: AiService
}
