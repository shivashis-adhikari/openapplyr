import { type ProcArgs, type ProcName, type ProcOutput, api } from '../../shared/api'
import { AppError } from '../core/errors'

export type Handler<N extends ProcName> = (input: ProcArgs<N>) => Promise<ProcOutput<N>> | ProcOutput<N>
type AnyHandler = (input: unknown) => unknown

/** Validates every call against the shared contract before a handler sees it. */
export class Router {
  private readonly handlers = new Map<string, AnyHandler>()

  on<N extends ProcName>(name: N, handler: Handler<N>): void {
    if (this.handlers.has(name)) throw new Error(`Duplicate handler for ${name}`)
    this.handlers.set(name, handler as AnyHandler)
  }

  missing(): string[] {
    return Object.keys(api).filter((n) => !this.handlers.has(n))
  }

  async handle(name: string, rawInput: unknown): Promise<unknown> {
    const def = (api as Record<string, { input: { safeParse(v: unknown): { success: boolean; data?: unknown; error?: { issues: { path: PropertyKey[]; message: string }[] } } } }>)[name]
    const handler = this.handlers.get(name)
    if (!def || !handler) throw new AppError('UNKNOWN_PROCEDURE', `Unknown action: ${name}`, { permanent: true })
    const parsed = def.input.safeParse(rawInput)
    if (!parsed.success) {
      const issue = parsed.error?.issues[0]
      const where = issue?.path.length ? ` (${issue.path.map(String).join('.')})` : ''
      throw new AppError('INVALID_INPUT', `Invalid input for ${name}${where}: ${issue?.message ?? 'rejected'}`, { permanent: true })
    }
    return handler(parsed.data)
  }
}
