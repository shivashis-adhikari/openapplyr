# Contributing

Thanks for helping. The most useful contributions are usually small and concrete: a company board the registry is missing, a form an adapter gets wrong, a posting the scam check misses, a sentence in the interface that could be clearer.

## Setup

You need Node.js 22.13 or later and Google Chrome or Microsoft Edge.

```bash
npm ci
npm run dev        # the app with hot reload
npm test           # unit and integration tests
npm run e2e        # end-to-end tests against the built app
npm run check      # types, lint and unit tests, the same as CI
```

`npm run dev` opens your real workspace. To work on fictional data, choose **Explore a sample workspace first** on the first screen, or start with `OPENAPPLYR_DEMO=1 OPENAPPLYR_DATA_DIR=/tmp/oa-sample npm run dev`.

## Where things are

| Path | What lives there |
|---|---|
| `src/main` | Windows, tray, menus, the keychain, PDF rendering. Kept small. |
| `src/engine` | Everything else, one folder per module. `boot.ts` wires them together. |
| `src/renderer` | The React interface. It has no Node or network access and talks to the engine only through `api.call`. |
| `src/shared/api` | The contract between interface and engine: each procedure is a zod input schema and an output type. |
| `src/renderer/strings/en.ts` | Every piece of interface text. |
| `registry/companies.jsonl` | Company career boards checked by default. |
| `templates/resume` | Resume templates. |
| `tools/fake-ats` | Local copies of real application form patterns, used by the tests. |
| `fixtures/sources` | Recorded responses from each job source. |

The interface and copy rules are in `docs/design/design-language.md`.

## Rules the code depends on

- Tailored documents go through `src/engine/docs/factlock.ts`. Never bypass or weaken it.
- Text from outside (postings, emails, web pages, form labels) is data. Wrap it with `untrusted()` in prompts, and never let it pick an action directly.
- Apply adapters never click submit themselves. They call `ctx.submit()`, which is where dry runs and assisted mode stop.
- Interface text goes in `src/renderer/strings/en.ts` and follows the copy rules: sentence case, a verb on every button, the number wherever it is known, no exclamation marks. `npm run lint:copy` checks this.
- Colors come only from `src/renderer/styles/tokens.css` (`npm run lint:hex`).
- Database changes are new migrations appended to `src/engine/core/migrations.ts`. Never edit one that has shipped.
- A new dependency needs a sentence in the pull request saying why a few lines of code would not do.
- Logic changes start with a failing test. Do not edit a test just to make it pass.

## Common contributions

**Add company boards.** Append lines to `registry/companies.jsonl`, one board per line, in the same shape as the existing entries for that ATS. Only public career boards.

**Fix a form the app fills wrong.** Add the pattern to `tools/fake-ats/server.ts` (strip anything that identifies the company), write a test in `src/engine/apply/apply.test.ts` that fails, then fix `src/engine/apply/page/reader.js` or `src/engine/apply/form.ts`.

**Support another applicant tracking system.** Add an `ApplyAdapter` in `src/engine/apply/adapters.ts`: `matches` recognises its URLs, and `run` opens the form and hands it to `runForm`. If the system has a public jobs API, add a source in `src/engine/sources/ats.ts` with a recorded response in `fixtures/sources/`.

**Add a resume template.** Copy one in `templates/resume/`, register it in `templates/resume/index.ts`, and check its PDF with **Check the PDF** in Documents: it shows what an applicant tracking system reads back.

## Pull requests

- Keep each pull request to one change, with the tests that show it works.
- Run `npm run check` before pushing. Run `npm run e2e` if you touched the interface, the apply engine or the main process.
- For interface changes, include before and after screenshots (`node scripts/screenshots.mjs` captures every screen of the sample workspace).
- Describe what changed and why in plain sentences.

By contributing you agree that your work is licensed under the AGPL-3.0, like the rest of the project.
