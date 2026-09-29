import type { z } from 'zod'

/** A procedure: a runtime input schema (validated in the engine) plus a compile-time output type. */
export type Proc<S extends z.ZodType, O> = { input: S; output: O }

export const proc =
  <O>() =>
  <S extends z.ZodType>(input: S): Proc<S, O> => ({ input, output: undefined as unknown as O })
