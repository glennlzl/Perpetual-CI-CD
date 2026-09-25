// Journey code for manager tests: the smallest valid Playwright code for a reviewed case, one empty milestone per
// step. Saved as each case's draft, it lets a person's run (options.manual) start the case's journey.
/** A reviewed case, as far as its journey code names it. */
export type JourneyCase = { id: string; name?: string; steps?: readonly { id: string }[] };
export const codeFor = (item: JourneyCase) => `import { test } from 'perpetual';

test(${JSON.stringify(item.name || item.id)}, async ({ page, journey }) => {
${(item.steps || []).map(step => `  await journey.milestone(${JSON.stringify(step.id)}, async () => {});`).join('\n')}
});
`;

export async function draftCode<C>(manager: { saveSpec(context: C, input: { caseId: string; code: string }): Promise<unknown> }, context: C, cases: readonly JourneyCase[]) {
  for (const item of cases) await manager.saveSpec(context, { caseId: item.id, code: codeFor(item) });
}

// A person's run, which may try each journey's draft code.
export const manual = { manual: true };
