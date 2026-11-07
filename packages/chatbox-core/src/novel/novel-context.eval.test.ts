/**
 * Deterministic context eval (no model calls). Run with `pnpm eval:novel-context`
 * to print the report; it also runs as part of the normal unit suite.
 *
 * It answers one question: for a long novel, does the writer's context contain
 * the facts it needs, stay inside the budget, and stay free of what it does not need?
 *
 * Asserted: lore recall, lore precision, budget, verbatim recency.
 * Measured only: recall of facts that exist solely in old prose. Phase 1 has no
 * automation for these, so that number is the baseline later phases must beat.
 */
import { describe, expect, it } from 'vitest'
import { assembleNovelContext } from './assemble'
import type { NovelRecord } from './chapter-record'
import { buildNovelSnapshot, foldNovelMemory } from './memory'
import { buildNovelFixture, type FixtureLanguage } from './testing/novel-fixture'
import { estimateNovelTokens } from './tokens'
import type { NovelAssembly, NovelTurn } from './types'

const countTokens = (text: string) => estimateNovelTokens(text, 'default')
const BUDGETS = [8_000, 32_000, 60_000]
const LANGUAGES: FixtureLanguage[] = ['zh', 'en']

function contextText(assembly: NovelAssembly): string {
  return [
    assembly.constantLoreText,
    assembly.storySoFar,
    assembly.volatileBlock,
    ...assembly.turns.map((t) => t.text),
  ].join('\n')
}

const report: string[] = []

describe.each(LANGUAGES)('novel context eval (%s)', (language) => {
  const fixture = buildNovelFixture(language)
  const history = (upToChapter: number): NovelTurn[] => fixture.turns.slice(0, upToChapter * 2 - 1)
  const withInstruction = (instruction: string, upToChapter: number): NovelTurn[] => [
    ...fixture.turns.slice(0, (upToChapter - 1) * 2),
    { id: 'probe', role: 'user', text: instruction },
  ]
  const assemble = (budget: number, turns: NovelTurn[]) =>
    assembleNovelContext({
      totalBudgetTokens: budget,
      countTokens,
      systemPrompt: 'You are a novelist.',
      lore: fixture.lore,
      turns,
      // Everything before the current reply counts as recorded here.
      coveredThroughTurnId: turns.at(-2)?.id,
    })

  it('has a fixture large enough to need trimming', () => {
    const total = fixture.turns.reduce((sum, t) => sum + countTokens(t.text), 0)
    expect(total).toBeGreaterThan(BUDGETS[BUDGETS.length - 1] * 3)
  })

  describe.each(BUDGETS)('budget %i', (budget) => {
    it('stays inside the budget at every probe point', () => {
      for (const chapter of [5, 30, 80, fixture.chapterCount]) {
        const result = assemble(budget, history(chapter))
        expect(result.manifest.usedTokens).toBeLessThanOrEqual(budget)
        expect(result.manifest.overBudget).toBe(false)
      }
    })

    it('recalls every lore fact when the instruction mentions its key', () => {
      const lastChapter = fixture.chapterCount
      for (const probe of fixture.loreProbes) {
        const result = assemble(budget, withInstruction(probe.instruction, lastChapter))
        expect(contextText(result), probe.entryId).toContain(probe.marker)
      }
    })

    it('leaves unmentioned lore out', () => {
      const result = assemble(
        budget,
        withInstruction(language === 'zh' ? '继续写。' : 'Keep writing.', fixture.chapterCount)
      )
      for (const probe of fixture.loreProbes) expect(contextText(result), probe.entryId).not.toContain(probe.marker)
      expect(result.volatileBlock).toBe('')
    })

    it('keeps the most recent prose verbatim', () => {
      const result = assemble(budget, history(fixture.chapterCount))
      const lastProse = fixture.turns[fixture.turns.length - 3]
      expect(result.turns.map((t) => t.id)).toContain(lastProse.id)
    })

    it('reports old-prose recall (measured, not asserted)', () => {
      const lastChapter = fixture.chapterCount
      let recalled = 0
      for (const fact of fixture.proseFacts) {
        const result = assemble(budget, withInstruction(fact.query, lastChapter))
        if (contextText(result).includes(fact.marker)) recalled++
      }
      // The same probes with records in place. The notes are scripted, so this measures how recall
      // works once the facts are recorded, not how well a real model records them.
      const records: NovelRecord[] = Array.from({ length: lastChapter }, (_, index) => {
        const chapter = index + 1
        const fact = fixture.proseFacts.find((item) => item.chapter === chapter)
        return {
          kind: 'chapter',
          id: `a${chapter}`,
          messageId: `a${chapter}`,
          covers: [`u${chapter}`, `a${chapter}`],
          note: {
            summary: `第${chapter}章的概要。`,
            inScene: [],
            characters: [],
            terms: [],
            hooksPlanted: fact ? [{ text: fact.query, evidence: fact.marker }] : [],
          },
          resolvedHookIds: [],
          model: 'scripted',
          createdAt: chapter,
        }
      })
      const snapshot = buildNovelSnapshot(
        foldNovelMemory(
          records,
          fixture.turns.map((turn) => turn.id)
        )
      )
      let recalledWithRecords = 0
      for (const fact of fixture.proseFacts) {
        const turns = withInstruction(fact.query, lastChapter)
        const result = assembleNovelContext({
          totalBudgetTokens: budget,
          countTokens,
          systemPrompt: 'You are a novelist.',
          lore: fixture.lore,
          turns,
          coveredThroughTurnId: turns.at(-2)?.id,
          stateLines: snapshot.stateLines,
          storySegments: snapshot.storySegments,
        })
        if (contextText(result).includes(fact.marker)) recalledWithRecords++
      }
      expect(recalledWithRecords).toBe(fixture.proseFacts.length)

      const sample = assemble(budget, history(lastChapter))
      report.push(
        `${language} budget=${String(budget).padStart(6)}  recent turns kept=${String(sample.turns.length).padStart(3)}/${fixture.turns.length - 1}` +
          `  used=${String(sample.manifest.usedTokens).padStart(6)}  old-prose recall=${recalled}/${fixture.proseFacts.length}, with records=${recalledWithRecords}/${fixture.proseFacts.length}`
      )
      expect(recalled).toBeGreaterThanOrEqual(0)
    })
  })
})

describe('report', () => {
  it('prints the summary', () => {
    // biome-ignore lint/suspicious/noConsole: printing this report is the purpose of the eval script
    console.log(`\nnovel-context eval (Phase 1 baseline: no summaries, no archive)\n${report.join('\n')}\n`)
    expect(report.length).toBeGreaterThan(0)
  })
})
