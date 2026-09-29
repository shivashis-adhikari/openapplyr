import type { WireError } from '../../shared/host'

/**
 * An error whose message is written for the user: what happened and, where possible, what to do.
 * `permanent` tells the task queue not to retry.
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly options: { detail?: string; permanent?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause })
    this.name = 'AppError'
  }
  get permanent(): boolean {
    return this.options.permanent ?? false
  }
  get detail(): string | undefined {
    return this.options.detail
  }
}

export function isPermanent(err: unknown): boolean {
  return err instanceof AppError && err.permanent
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === 'string' ? err : JSON.stringify(err)
}

export function toWire(err: unknown): WireError {
  if (err instanceof AppError) {
    return { code: err.code, message: err.message, ...(err.detail ? { detail: err.detail } : {}) }
  }
  const message = errorMessage(err)
  return { code: 'INTERNAL', message: 'OpenApplyr hit an unexpected error. Details are in the log.', detail: message }
}
