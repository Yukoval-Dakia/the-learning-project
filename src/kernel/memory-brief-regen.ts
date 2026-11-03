// The memory brief regen queue contract. Agency mounts the handler; Agency and
// Practice both enqueue through here so the queue name, singleton key and slot
// cannot drift between producers.

export const MEMORY_BRIEF_REGEN_QUEUE = 'memory_brief_regen';

const REGEN_SINGLETON_SECONDS = 6 * 60;
// Every practice answer reaches a subject brief, and each regen is one paid LLM
// call. pg-boss keeps one job per key per slot, so a subject regenerates at most
// six times a day.
const SUBJECT_REGEN_SINGLETON_SECONDS = 4 * 60 * 60;

export async function enqueueMemoryBriefRegen(
  boss: { send(name: string, data: object, options?: object): Promise<string | null> },
  scopeKey: string,
  // Optional sweep timestamp: a never-built subject floors its reload at
  // `now - lookbackDays`. Threading the sweep's now closes the race where an event
  // near the edge is detected at T but ages out by regen time. Global jobs pass none.
  now?: Date,
): Promise<void> {
  await boss.send(
    MEMORY_BRIEF_REGEN_QUEUE,
    now ? { scope_key: scopeKey, now: now.toISOString() } : { scope_key: scopeKey },
    {
      singletonKey: `memory.regen.${scopeKey}`,
      singletonSeconds: scopeKey.startsWith('subject:')
        ? SUBJECT_REGEN_SINGLETON_SECONDS
        : REGEN_SINGLETON_SECONDS,
      singletonNextSlot: true,
    },
  );
}
