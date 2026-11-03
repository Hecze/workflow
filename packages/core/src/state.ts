import { globalSingleton } from '@workflow/utils';
import { Immer } from 'immer';

/**
 * Experimental: immutable state updated with an immer-style `produce`.
 *
 * `produce` behaves like immer's: the recipe edits a draft and the result is a
 * frozen value that shares every unchanged part with its base. Workflow also
 * records which value each result was produced from and what changed, so that
 * state passed between steps can be stored without repeating unchanged data.
 */

type Leaf =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | undefined
  | null
  | Date
  | Uint8Array
  | ((...args: any[]) => unknown);

// Homomorphic mapped types keep arrays as arrays and tuples as tuples, with
// their length and per-position types, like immer's own types.
export type Immutable<T> = T extends Leaf
  ? T
  : { readonly [K in keyof T]: Immutable<T[K]> };

export type Draft<T> = T extends Leaf
  ? T
  : { -readonly [K in keyof T]: Draft<T[K]> };

/** @internal */
export type StatePath = readonly (string | number)[];

/** Workflow's own change format. It is stored in the event log, so it never depends on immer. */
/** @internal */
export type StateOp =
  | { readonly op: 'set'; readonly path: StatePath; readonly value: unknown }
  | { readonly op: 'del'; readonly path: StatePath }
  | {
      readonly op: 'append';
      readonly path: StatePath;
      readonly items: readonly unknown[];
    };

/** @internal */
export interface StateLineage {
  readonly logId: string;
  readonly version: string;
  /** The version this value was produced from; absent for a new root. */
  readonly base?: string;
  /** Changes from `base`; absent for a new root. */
  readonly ops?: readonly StateOp[];
  /** Approximate change bytes since the last whole value, for the snapshot rule. */
  readonly bytesSinceFull: number;
}

const lineages = globalSingleton(
  '@workflow/core//state-lineage',
  1,
  () => new WeakMap<object, StateLineage>()
);

/** @internal */
export function lineageOf(value: unknown): StateLineage | undefined {
  return value !== null && typeof value === 'object'
    ? lineages.get(value)
    : undefined;
}

/** @internal */
export function setLineage(value: object, lineage: StateLineage): void {
  lineages.set(value, lineage);
}

/** A private engine: an app's own immer settings never affect Workflow's. */
// per-copy-ok: a stateless engine with fixed settings; every copy behaves the same.
const engine = new Immer({ autoFreeze: true });

type Dict = Record<string, unknown>;

/** @internal */
export function isPlainObject(value: unknown): value is Dict {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

function newId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * @internal
 * The changes from `base` to `next`, found by identity: immer shares every
 * unchanged subtree, so only changed paths are visited. An array that only grew
 * at the end becomes one `append`; any other array change replaces the array.
 */
export function diffState(
  base: unknown,
  next: unknown,
  path: (string | number)[] = [],
  out: StateOp[] = []
): StateOp[] {
  if (Object.is(base, next)) return out;
  if (Array.isArray(base) && Array.isArray(next)) {
    // Holes are skipped by element comparisons, so a sparse array is stored whole.
    if (hasHoles(base) || hasHoles(next)) {
      out.push({ op: 'set', path, value: next });
      return out;
    }
    if (
      next.length >= base.length &&
      base.every((value, i) => Object.is(value, next[i]))
    ) {
      if (next.length > base.length)
        out.push({ op: 'append', path, items: next.slice(base.length) });
    } else if (next.length === base.length) {
      for (let i = 0; i < next.length; i++)
        diffState(base[i], next[i], [...path, i], out);
    } else {
      out.push({ op: 'set', path, value: next });
    }
    return out;
  }
  if (
    isPlainObject(base) &&
    isPlainObject(next) &&
    Object.getPrototypeOf(base) === Object.getPrototypeOf(next)
  ) {
    for (const key of Object.keys(base))
      if (!Object.hasOwn(next, key))
        out.push({ op: 'del', path: [...path, key] });
    for (const key of Object.keys(next)) {
      if (!Object.hasOwn(base, key))
        out.push({ op: 'set', path: [...path, key], value: next[key] });
      else diffState(base[key], next[key], [...path, key], out);
    }
    return out;
  }
  out.push({ op: 'set', path, value: next });
  return out;
}

function hasHoles(array: readonly unknown[]): boolean {
  for (let i = 0; i < array.length; i++) if (!(i in array)) return true;
  return false;
}

/** @internal */
export function opsBytes(ops: readonly StateOp[]): number {
  try {
    return JSON.stringify(ops)?.length ?? 0;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Like immer's `produce`. The result is frozen and shares unchanged parts with
 * `base`; Workflow additionally records its lineage so it can be stored by reference.
 */
export function produce<T>(
  base: T | Immutable<T>,
  // biome-ignore lint/suspicious/noConfusingVoidType: like immer, a recipe either returns nothing or a replacement
  recipe: (draft: Draft<T>) => void | T | Immutable<T>
): Immutable<T> {
  const next = engine.produce(base as any, recipe as any) as Immutable<T>;
  if (Object.is(next, base) || next === null || typeof next !== 'object')
    return next;
  const from = lineageOf(base);
  const ops = diffState(base, next);
  setLineage(next as object, {
    logId: from?.logId ?? newId(),
    version: newId(),
    base: from?.version,
    ops: from === undefined ? undefined : ops,
    bytesSinceFull: (from?.bytesSinceFull ?? 0) + opsBytes(ops),
  });
  return next;
}

/**
 * Plain-object state may have own properties named `__proto__`, `constructor`
 * or `prototype`. Reading only own properties and writing with
 * `defineProperty` keeps them ordinary data and never reaches a prototype.
 */
function ownValue(object: Dict, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}
function setOwn(object: Dict, key: string, value: unknown): void {
  Object.defineProperty(object, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}
function copyObject(object: Dict): Dict {
  const copy: Dict =
    Object.getPrototypeOf(object) === null ? Object.create(null) : {};
  for (const key of Object.keys(object)) setOwn(copy, key, object[key]);
  return copy;
}

/** Copies only the containers on each changed path; everything else stays shared. */
function updateIn(
  value: unknown,
  path: StatePath,
  at: number,
  update: (value: unknown) => unknown
): unknown {
  if (at === path.length) return update(value);
  const key = path[at] as string | number;
  if (Array.isArray(value)) {
    const copy = value.slice();
    copy[Number(key)] = updateIn(value[Number(key)], path, at + 1, update);
    return copy;
  }
  if (!isPlainObject(value))
    throw new Error('State change does not match its base');
  const copy = copyObject(value);
  setOwn(
    copy,
    String(key),
    updateIn(ownValue(value, String(key)), path, at + 1, update)
  );
  return copy;
}

/** @internal */
export function applyStateOps(base: unknown, ops: readonly StateOp[]): unknown {
  let value = base;
  for (const change of ops) {
    if (change.op === 'set')
      value = updateIn(value, change.path, 0, () => change.value);
    else if (change.op === 'append')
      value = updateIn(value, change.path, 0, (array) => {
        if (!Array.isArray(array))
          throw new Error('State append does not match its base');
        return [...array, ...change.items];
      });
    else {
      const parent = change.path.slice(0, -1);
      const key = change.path[change.path.length - 1] as string | number;
      value = updateIn(value, parent, 0, (object) => {
        if (!isPlainObject(object))
          throw new Error('State delete does not match its base');
        const copy = copyObject(object);
        delete copy[String(key)];
        return copy;
      });
    }
  }
  return value;
}
