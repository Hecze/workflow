import { describe, expect, it } from 'vitest';
import { lineageOf, produce } from '../state.js';
import { decodeFormatPrefix } from './format.js';
import { markStateSource, StateContext } from './state-refs.js';
import * as workflow from './workflow.js';

type Message = { role: string; content: string };
type Session = { history: Message[]; context: Record<string, unknown> };

const write = (value: unknown, stateContext: StateContext) =>
  workflow.serialize(value, { stateContext });
const read = (bytes: Uint8Array, stateContext: StateContext) =>
  workflow.deserialize(bytes, { stateContext }) as any;
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const cold = (...payloads: Uint8Array[]) => {
  const context = new StateContext();
  for (const p of payloads)
    context.ingest(decodeFormatPrefix(p).payload as Uint8Array);
  return context;
};

/** One session as a replay sees it: step 1 is given plain values and returns produced ones. */
function session() {
  const body = new StateContext();
  const start: Session = { history: [], context: { trace: { t: 0 } } };
  const given = read(write({ session: start }, body), body).session as Session;
  const s1 = produce(given, (draft) => {
    draft.history.push(
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' }
    );
    (draft.context.trace as { t: number }).t = 1;
  });
  const output1 = write({ session: s1 }, new StateContext());
  return { body, output1 };
}

describe('workflow/state values stored by reference', () => {
  it('stores the first result whole, later inputs as references and outputs as changes', () => {
    const { body, output1 } = session();
    expect(text(output1)).toContain('"full"');
    const v1 = read(output1, body).session;
    expect(lineageOf(v1)).toBeDefined();
    expect(Object.isFrozen(v1.history)).toBe(true);

    const input2 = write({ session: v1 }, body);
    expect(text(input2)).toContain('"ref"');
    expect(input2.byteLength).toBeLessThan(300);

    const given = read(input2, body).session;
    expect(given).toBe(v1);
    const s2 = produce(given as Session, (draft) => {
      draft.history.push(
        { role: 'user', content: 'next' },
        { role: 'assistant', content: 'ok' }
      );
    });
    const output2 = write({ session: s2 }, body);
    expect(text(output2)).toContain('"patch"');
    expect(text(output2)).toContain('"append"');
    expect(text(output2)).not.toContain('hello');
    expect(
      read(output2, body).session.history.map((m: Message) => m.content)
    ).toEqual(['hello', 'hi', 'next', 'ok']);
  });

  it('keeps step inputs the same size as the history grows', () => {
    const { body, output1 } = session();
    let value = read(output1, body).session;
    const sizes: number[] = [];
    for (let turn = 0; turn < 50; turn++) {
      const input = write({ session: value }, body);
      sizes.push(input.byteLength);
      const next = produce(read(input, body).session as Session, (draft) => {
        draft.history.push({
          role: 'user',
          content: `q${turn} ${'x'.repeat(500)}`,
        });
        draft.history.push({
          role: 'assistant',
          content: `a${turn} ${'y'.repeat(500)}`,
        });
      });
      value = read(write({ session: next }, body), body).session;
    }
    expect(value.history).toHaveLength(102);
    expect(Math.max(...sizes)).toBe(Math.min(...sizes));
  });

  it('rebuilds a referenced input in a new invocation from outputs alone, and encodes its output as a change', () => {
    const { body, output1 } = session();
    const v1 = read(output1, body).session;
    const input2 = write({ session: v1 }, body);

    const retry = cold(output1);
    const given = read(input2, retry).session;
    expect(given).toStrictEqual(v1);
    const output2 = write(
      {
        session: produce(
          given as Session,
          (d) => void d.history.push({ role: 'assistant', content: 'cold' })
        ),
      },
      retry
    );
    expect(text(output2)).toContain('"patch"');

    const replayed = read(output2, body).session;
    expect(
      read(write({ session: replayed }, body), cold(output1, output2)).session
    ).toStrictEqual(replayed);
  });

  it('refers to long strings a hook payload already stores instead of storing them again', () => {
    const { body, output1 } = session();
    const message = 'Weather in Oslo for the next three days, please. '.repeat(
      4
    );
    const payload = { message };
    markStateSource(payload, 'hook:1');
    const hook = write(payload, new StateContext());
    expect(text(hook)).toContain('"source"');
    read(hook, body);

    const v1 = read(output1, body).session;
    const s2 = produce(v1 as Session, (draft) => {
      draft.history.push({ role: 'user', content: message });
    });
    const output2 = write({ session: s2 }, body);
    expect(text(output2)).not.toContain('Weather in Oslo');
    expect(read(output2, body).session.history.at(-1).content).toBe(message);
    expect(
      read(output2, cold(output1, hook)).session.history.at(-1).content
    ).toBe(message);
  });

  it('stores a value whole again once its overwrites outgrow it', () => {
    const body = new StateContext();
    let value = read(
      write(
        { s: produce({ blob: '' }, (d) => void (d.blob = 'x'.repeat(20_000))) },
        body
      ),
      body
    ).s;
    const kinds: string[] = [];
    for (let i = 0; i < 12; i++) {
      const out = write(
        {
          s: produce(
            value as { blob: string },
            (d) => void (d.blob = String(i).repeat(20_000))
          ),
        },
        body
      );
      kinds.push(text(out).includes('"full"') ? 'full' : 'patch');
      value = read(out, body).s;
    }
    expect(kinds[0]).toBe('patch');
    expect(kinds).toContain('full');
  });

  it('writes a value whole where its base is unknown, and fails on a missing version', () => {
    const { body, output1 } = session();
    const v1 = read(output1, body).session;
    const elsewhere = write({ session: v1 }, new StateContext());
    expect(text(elsewhere)).toContain('"full"');
    expect(read(elsewhere, new StateContext()).session).toStrictEqual(v1);
    expect(() =>
      read(write({ session: v1 }, body), new StateContext())
    ).toThrow(/Missing workflow state version/);
  });

  it('recovers dates and bytes, and refuses values only workflow code could rebuild', () => {
    const body = new StateContext();
    const v0 = read(
      write({ s: produce({ items: [] as unknown[] }, () => {}) }, body),
      body
    ).s;
    const first = write(
      { s: produce(v0 as { items: unknown[] }, (d) => void d.items.push(1)) },
      body
    );
    const v1 = read(first, body).s;
    const at = new Date('2026-11-03T00:00:00Z');
    const second = write(
      {
        s: produce(
          v1 as { items: unknown[] },
          (d) => void d.items.push(at, new Uint8Array([1, 2]))
        ),
      },
      body
    );
    const recovered = read(
      write({ s: read(second, body).s }, body),
      cold(first, second)
    ).s;
    expect(recovered.items[1]).toEqual(at);
    expect(recovered.items[2]).toEqual(new Uint8Array([1, 2]));

    const unknown = new TextEncoder().encode(
      JSON.stringify([
        ['StateRefV1', 1],
        { kind: 2, logId: 3, version: 4, value: 5 },
        'full',
        'l',
        'v',
        ['Somewhere', 6],
        0,
      ])
    );
    expect(() => new StateContext().ingest(unknown)).toThrow(
      /cannot be recovered/
    );
  });
});
