import { createHash } from 'node:crypto'
import { type ModelMessage, tool } from 'ai'
import { z } from 'zod'
import { untrusted } from '../ai/prompt'
import type { AiService } from '../ai/service'
import type { ApplyContext } from './context'
import { readPage } from './form'

const MAX_STEPS = 12
const SNAPSHOT_CHARS = 12_000

/**
 * The navigation agent. It is used only to reach an application form the DOM runner cannot find
 * (an unusual Apply flow, a cookie wall, a "choose a location" step). It can click and choose, never
 * type application answers and never press a control that sends the application: filling stays with
 * the runner and the answer policy, and ctx.click refuses submit-like controls.
 */
export async function findForm(ctx: ApplyContext, ai: AiService): Promise<boolean> {
  if (ai.isMock()) return false
  const tools = {
    click: tool({ description: 'Click a button or link by its ref.', inputSchema: z.object({ ref: z.string(), why: z.string() }) }),
    choose: tool({ description: 'Pick an option in a select control by its ref.', inputSchema: z.object({ ref: z.string(), option: z.string() }) }),
    form_ready: tool({ description: 'The application form (name, email, resume fields) is now on the page.', inputSchema: z.object({}) }),
    give_up: tool({ description: 'The form cannot be reached (login required, expired posting, or the page asks for something only the person can do).', inputSchema: z.object({ reason: z.string() }) }),
  }
  const messages: ModelMessage[] = []
  let lastAction = ''
  let repeats = 0
  for (let step = 0; step < MAX_STEPS; step++) {
    ctx.checkStopped()
    const snapshot = (await ctx.page.locator('body').ariaSnapshot({ mode: 'ai' }).catch(() => '')).slice(0, SNAPSHOT_CHARS)
    const hash = createHash('sha1').update(snapshot).digest('hex').slice(0, 8)
    messages.push({
      role: 'user',
      content: [
        `Goal: open the application form for "${ctx.job.title}" at ${ctx.job.company}. Page ${ctx.page.url()} (snapshot ${hash}).`,
        untrusted('page accessibility snapshot', snapshot),
        'Call exactly one tool.',
      ].join('\n\n'),
    })
    const r = await ai.turn({
      role: 'agent',
      task: 'Find application form',
      system:
        'You operate a web browser for a job seeker, only to reach a job application form. You never fill in answers and never send an application. ' +
        'Prefer buttons named Apply, Apply now, or I am interested. Dismiss cookie banners with the most privacy-preserving choice.',
      messages,
      tools,
      toolChoice: 'required',
      maxOutputTokens: 400,
      signal: ctx.signal,
      mock: () => ({ text: '', toolCalls: [{ toolName: 'give_up', input: { reason: 'offline model' } }] }),
    })
    const call = r.toolCalls[0]
    if (!call) return false
    const input = call.input as { ref?: string; option?: string; why?: string; reason?: string }
    const action = `${call.toolName}:${input.ref ?? ''}:${input.option ?? ''}`
    repeats = action === lastAction ? repeats + 1 : 0
    lastAction = action
    ctx.step('agent', `${call.toolName}${input.ref ? ` ${input.ref}` : ''}${input.why ? `: ${input.why}` : input.reason ? `: ${input.reason}` : ''} (snapshot ${hash})`)
    if (repeats >= 2) return false
    messages.push({ role: 'assistant', content: `${call.toolName} ${JSON.stringify(input)}` })
    try {
      if (call.toolName === 'form_ready') {
        const s = await readPage(ctx.page.mainFrame())
        return s.fields.filter((f) => f.kind !== 'file').length >= 2
      }
      if (call.toolName === 'give_up') return false
      const target = ctx.page.locator(`aria-ref=${input.ref}`)
      if (call.toolName === 'click') await ctx.click(target, input.why ?? 'Clicked')
      if (call.toolName === 'choose' && input.option) await target.selectOption({ label: input.option })
      await ctx.page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined)
    } catch (err) {
      messages.push({ role: 'user', content: `That failed: ${String(err).split('\n')[0]}` })
    }
  }
  return false
}
