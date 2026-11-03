import { getWorldLazy } from '../runtime/get-world-lazy.js';
import type { PayloadKey } from './encryption.js';
import { decodeFormatPrefix, peekFormatPrefix } from './format.js';
import { STATE_REF_REDUCER, StateContext } from './state-refs.js';

const MAX_PAGES = 1000;
const MAX_BYTES = 256 * 1024 * 1024;

/**
 * Rebuilds the `workflow/state` versions a step input refers to when the step
 * runs without the replay that produced them (for example a retry in a new
 * invocation). Reads the run input, hook payloads and step outputs, never step
 * inputs, and runs no workflow code.
 */
export async function recoverStateContext(
  runId: string,
  key: PayloadKey | undefined,
  data: unknown
): Promise<StateContext | undefined> {
  if (
    !(data instanceof Uint8Array) ||
    peekFormatPrefix(data) !== 'devl' ||
    !new TextDecoder().decode(data).includes(`"${STATE_REF_REDUCER}"`)
  )
    return undefined;
  const world = await getWorldLazy();
  const context = new StateContext();
  const { prepareReplayPayload } = await import('../serialization.js');
  let bytes = 0;
  const ingest = async (value: unknown) => {
    if (value === undefined) return;
    const prepared = (await prepareReplayPayload(value, key)).data;
    if (
      !(prepared instanceof Uint8Array) ||
      peekFormatPrefix(prepared) !== 'devl'
    )
      return;
    bytes += prepared.byteLength;
    if (bytes > MAX_BYTES)
      throw new Error('Workflow state recovery byte limit');
    context.ingest(decodeFormatPrefix(prepared).payload);
  };
  const run = await world.runs.get(runId, { resolveData: 'all' });
  await ingest(run.input);
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const events = await world.events.list({
      runId,
      resolveData: 'skip-step-inputs',
      pagination: { cursor, sortOrder: 'asc', limit: 1000 },
    });
    context.stats.recoveryFetches++;
    const prepared = events.data.map((event) =>
      event.eventType === 'hook_received'
        ? event.eventData?.payload
        : event.eventType === 'step_completed'
          ? event.eventData?.result
          : undefined
    );
    // Versions build on earlier ones, so ingest in log order.
    for (const value of prepared) await ingest(value);
    if (!events.hasMore) return context;
    if (!events.cursor || seen.has(events.cursor))
      throw new Error('Workflow state recovery cursor did not advance');
    seen.add(events.cursor);
    cursor = events.cursor;
  }
  throw new Error('Workflow state recovery page limit');
}
