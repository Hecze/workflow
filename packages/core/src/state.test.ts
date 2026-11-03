import { describe, expect, it } from 'vitest';
import { applyStateOps, diffState, lineageOf, produce } from './state.js';

type Message = { role: string; content: string };

describe('produce', () => {
  it('behaves like immer: frozen result, shared unchanged parts, base kept when nothing changes', () => {
    const base = {
      history: [{ role: 'user', content: 'a' }] as Message[],
      context: { n: 1 },
    };
    const next = produce(base, (draft) => {
      draft.history.push({ role: 'assistant', content: 'b' });
    });
    expect(next.history).toHaveLength(2);
    expect(base.history).toHaveLength(1);
    expect(next.context).toBe(base.context);
    expect(Object.isFrozen(next)).toBe(true);
    expect(Object.isFrozen(next.history)).toBe(true);
    expect(produce(next, () => {})).toBe(next);
  });

  it('replaces the value when the recipe returns one', () => {
    const next = produce({ history: [1, 2, 3] }, () => ({ history: [9] }));
    expect(next).toEqual({ history: [9] });
  });

  it('records which value a result came from', () => {
    const first = produce({ count: 0 }, (draft) => {
      draft.count = 1;
    });
    const second = produce(first, (draft) => {
      draft.count = 2;
    });
    const a = lineageOf(first)!;
    const b = lineageOf(second)!;
    expect(a.base).toBeUndefined();
    expect(b.logId).toBe(a.logId);
    expect(b.base).toBe(a.version);
    expect(b.ops).toEqual([{ op: 'set', path: ['count'], value: 2 }]);
  });
});

describe('recorded changes', () => {
  it('records growth at the end of an array as one append and other changes per path', () => {
    const base = Object.assign(Object.create(null), {
      a: 1,
      b: { c: [1, 2] },
      gone: true,
    });
    const next = produce(base, (draft: any) => {
      draft.a = 2;
      draft.b.c.push(3, 4);
      delete draft.gone;
      draft.added = 'x';
    });
    const ops = diffState(base, next);
    expect(ops).toEqual([
      { op: 'del', path: ['gone'] },
      { op: 'set', path: ['a'], value: 2 },
      { op: 'append', path: ['b', 'c'], items: [3, 4] },
      { op: 'set', path: ['added'], value: 'x' },
    ]);
    const rebuilt = applyStateOps(base, ops) as Record<string, unknown>;
    expect({ ...rebuilt }).toEqual({ ...next });
    expect(Object.getPrototypeOf(rebuilt)).toBe(null);
  });

  it('replaces an array that did not only grow at the end', () => {
    const base = { history: [1, 2, 3] };
    const next = produce(base, (draft) => {
      draft.history = [9];
    });
    expect(diffState(base, next)).toEqual([
      { op: 'set', path: ['history'], value: [9] },
    ]);
  });

  it('applies changes without editing the base', () => {
    const base = Object.freeze({ list: Object.freeze([1]) });
    const next = applyStateOps(base, [
      { op: 'append', path: ['list'], items: [2] },
    ]);
    expect(next).toEqual({ list: [1, 2] });
    expect(base.list).toEqual([1]);
  });
});
