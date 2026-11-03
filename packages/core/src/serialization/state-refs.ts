import { globalSingleton } from '@workflow/utils';
import { parse } from 'devalue';
import {
  applyStateOps,
  isPlainObject,
  lineageOf,
  opsBytes,
  type StateLineage,
  type StateOp,
  setLineage,
} from '../state.js';
import { getCommonRevivers } from './reducers/common.js';

/**
 * Stores `workflow/state` values by reference (opt-in, `WORKFLOW_STATE_REFS=1`).
 *
 * A value produced by `produce()` is written as a reference to its version
 * when that version is already in the run's log, as only its change when its
 * base version is, and whole otherwise. Long strings that already arrived in a
 * hook payload or the run input are written as references to that payload.
 * Readers rebuild values from the run's own log, so nothing refers outside it.
 */

export const STATE_REF_REDUCER = 'StateRefV1';
export const STATE_SOURCE_REDUCER = 'StateSrcV1';

/** Above this many change bytes since the last whole value, and twice the value's size, write it whole. */
const SNAPSHOT_MIN_BYTES = 64 * 1024;
/** Shorter strings are not worth a reference. */
const SOURCE_STRING_MIN = 128;
const MAX_ID = 256;
const MAX_PATH = 64;

type Dict = Record<string, unknown>;
interface Version {
  readonly logId: string;
  readonly value: unknown;
  readonly bytesSinceFull: number;
}
interface SourceString {
  readonly id: string;
  readonly path: readonly (string | number)[];
}

/** A string in a state change that is stored in a hook payload or run input instead. */
export class StateSourceRef {
  constructor(
    readonly id: string,
    readonly path: readonly (string | number)[]
  ) {}
}

const OPAQUE = Symbol.for('@workflow/core//state-refs-opaque');
/**
 * Tags devalue decodes itself, such as `null` for null-prototype objects.
 * Recovery must leave them to devalue; only unknown custom types become
 * placeholders.
 */
const DEVALUE_BUILTIN_TAGS = new Set([
  'null',
  'Object',
  'Date',
  'Set',
  'Map',
  'RegExp',
  'BigInt',
  'URL',
  'URLSearchParams',
  'ArrayBuffer',
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float16Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
]);

function deepFreeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  // Byte views cannot be frozen; like dates they are replaced whole, never edited.
  if (ArrayBuffer.isView(value)) return;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze((value as Dict)[key]);
}

function shallowCopy(value: unknown): unknown {
  if (Array.isArray(value)) return [...value];
  return Object.getPrototypeOf(value) === null
    ? Object.assign(Object.create(null) as Dict, value)
    : { ...(value as object) };
}

function jsonBytes(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function checkedId(id: unknown, what: string): string {
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID)
    throw new Error(`Invalid ${what}`);
  return id;
}

/** Marks a payload (a hook payload or run input) whose long strings later state may refer to. */
const sourceMarks = globalSingleton(
  '@workflow/core//state-ref-sources',
  1,
  () => new WeakMap<object, string>()
);
export function markStateSource(value: unknown, id: string): void {
  if (value !== null && typeof value === 'object')
    sourceMarks.set(value, checkedId(id, 'state source id'));
}

/** One invocation's view of the tracked values and sources in a run's log. */
export class StateContext {
  private readonly versions = new Map<string, Version>();
  /**
   * Each source's referenceable strings by path, captured when the source is
   * first seen. Code may edit a revived hook payload or run input later; state
   * changes must still resolve to the strings that were stored.
   */
  private readonly sources = new Map<string, Map<string, string>>();
  private readonly strings = new Map<string, SourceString>();
  readonly stats = {
    refs: 0,
    patches: 0,
    full: 0,
    sourceRefs: 0,
    recoveryFetches: 0,
  };

  /** devalue reducer: returns a record for tracked values and marked sources, `false` otherwise. */
  reduce = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') return false;
    const sourceId = sourceMarks.get(value);
    if (sourceId !== undefined) {
      this.addSource(sourceId, value);
      return { kind: 'source', id: sourceId, value: shallowCopy(value) };
    }
    // Writing references is opt-in; reading them is always supported, so runs
    // that stored references stay readable after the setting is turned off.
    const lineage = lineageOf(value);
    return lineage === undefined || !stateRefsEnabled()
      ? false
      : this.reduceTracked(value, lineage);
  };

  /** devalue reducer for the strings inside a state change that a source already holds. */
  reduceSourceRef = (value: unknown): unknown =>
    value instanceof StateSourceRef ? [value.id, value.path] : false;

  reviveSourceRef = ([id, path]: [
    string,
    (string | number)[],
  ]): StateSourceRef =>
    new StateSourceRef(checkedId(id, 'state source id'), path);

  revive = (d: Dict): unknown => {
    switch (d.kind) {
      case 'source':
        return this.reviveSource(d);
      case 'ref':
      case 'patch':
      case 'full':
        return this.reviveTracked(d);
      default:
        throw new Error('Unknown workflow state record');
    }
  };

  private reduceTracked(value: unknown, lineage: StateLineage): unknown {
    const { logId, version } = lineage;
    if (this.versions.get(version)?.logId === logId) {
      this.stats.refs++;
      return { kind: 'ref', logId, version };
    }
    const base =
      lineage.base === undefined ? undefined : this.versions.get(lineage.base);
    const snapshot =
      lineage.bytesSinceFull > SNAPSHOT_MIN_BYTES &&
      lineage.bytesSinceFull > 2 * jsonBytes(value);
    if (base?.logId === logId && lineage.ops !== undefined && !snapshot) {
      this.versions.set(version, {
        logId,
        value,
        bytesSinceFull: lineage.bytesSinceFull,
      });
      this.stats.patches++;
      return {
        kind: 'patch',
        logId,
        base: lineage.base,
        version,
        ops: this.withSourceRefs(lineage.ops),
      };
    }
    this.versions.set(version, { logId, value, bytesSinceFull: 0 });
    this.stats.full++;
    return { kind: 'full', logId, version, value: shallowCopy(value) };
  }

  private reviveTracked(d: Dict): unknown {
    const logId = checkedId(d.logId, 'workflow state log');
    const version = checkedId(d.version, 'workflow state version');
    const known = this.versions.get(version);
    if (d.kind === 'ref') {
      if (known?.logId !== logId)
        throw new Error(`Missing workflow state version ${logId}:${version}`);
      return known.value;
    }
    if (known !== undefined) return known.value;
    let value: unknown;
    let bytesSinceFull = 0;
    if (d.kind === 'full') {
      value = d.value;
    } else {
      const base =
        typeof d.base === 'string' ? this.versions.get(d.base) : undefined;
      if (base?.logId !== logId)
        throw new Error(
          `Missing workflow state base ${logId}:${String(d.base)}`
        );
      if (!Array.isArray(d.ops))
        throw new Error('Invalid workflow state change');
      const ops = this.resolveSourceRefs(d.ops) as StateOp[];
      value = applyStateOps(base.value, ops);
      bytesSinceFull = base.bytesSinceFull + opsBytes(ops);
    }
    this.assertKnownTypes(value);
    deepFreeze(value);
    this.versions.set(version, { logId, value, bytesSinceFull });
    if (value !== null && typeof value === 'object')
      setLineage(value, { logId, version, bytesSinceFull });
    return value;
  }

  private addSource(id: string, value: unknown): void {
    if (this.sources.has(id)) return;
    const captured = new Map<string, string>();
    this.sources.set(id, captured);
    const walk = (v: unknown, path: (string | number)[]) => {
      if (path.length > MAX_PATH) return;
      if (typeof v === 'string') {
        if (v.length < SOURCE_STRING_MIN) return;
        captured.set(JSON.stringify(path), v);
        if (!this.strings.has(v)) this.strings.set(v, { id, path });
      } else if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) walk(v[i], [...path, i]);
      } else if (isPlainObject(v)) {
        for (const key of Object.keys(v)) walk(v[key], [...path, key]);
      }
    };
    walk(value, []);
  }

  private reviveSource(d: Dict): unknown {
    const id = checkedId(d.id, 'state source id');
    this.addSource(id, d.value);
    return d.value;
  }

  /** Replaces long strings a source already holds; the result is serialized, never kept. */
  private withSourceRefs(ops: readonly StateOp[]): unknown[] {
    if (this.strings.size === 0) return [...ops];
    const replace = (v: unknown): unknown => {
      if (typeof v === 'string') {
        const at =
          v.length >= SOURCE_STRING_MIN ? this.strings.get(v) : undefined;
        if (at === undefined) return v;
        this.stats.sourceRefs++;
        return new StateSourceRef(at.id, at.path);
      }
      if (Array.isArray(v)) return v.map(replace);
      if (isPlainObject(v)) {
        const out: Dict =
          Object.getPrototypeOf(v) === null ? Object.create(null) : {};
        for (const key of Object.keys(v)) out[key] = replace(v[key]);
        return out;
      }
      return v;
    };
    return ops.map(replace);
  }

  private resolveSourceRefs(v: unknown): unknown {
    if (v instanceof StateSourceRef) {
      const captured = this.sources.get(v.id);
      if (captured === undefined)
        throw new Error(`Missing workflow state source ${v.id}`);
      const value = captured.get(JSON.stringify(v.path));
      if (value === undefined)
        throw new Error('Missing workflow state source field');
      return value;
    }
    if (Array.isArray(v)) return v.map((x) => this.resolveSourceRefs(x));
    if (isPlainObject(v)) {
      const out: Dict =
        Object.getPrototypeOf(v) === null ? Object.create(null) : {};
      for (const key of Object.keys(v))
        out[key] = this.resolveSourceRefs(v[key]);
      return out;
    }
    return v;
  }

  private assertKnownTypes(value: unknown, depth = 0): void {
    if (depth > 256 || value === null || typeof value !== 'object') return;
    if ((value as Dict)[OPAQUE as unknown as string] === true)
      throw new Error(
        'Workflow state holds a value that cannot be recovered without running workflow code'
      );
    for (const key of Object.keys(value))
      this.assertKnownTypes((value as Dict)[key], depth + 1);
  }

  /**
   * Cold recovery: reads the state records of one decoded payload (JSON text after
   * the format prefix) without running workflow code. Other custom types become
   * placeholders, which fail loudly if they end up inside tracked state.
   */
  ingest(payload: Uint8Array): void {
    const text = new TextDecoder().decode(payload);
    if (!text.includes(STATE_REF_REDUCER)) return;
    const opaque = () => ({ [OPAQUE]: true });
    // Workflow's own encodings of Date, Map, typed arrays and the like revive as
    // usual; anything that needs workflow code (streams, class instances) does not.
    const common = getCommonRevivers(globalThis) as Record<
      string,
      (v: any) => unknown
    >;
    const pick = (key: string | symbol) =>
      typeof key !== 'string'
        ? undefined
        : Object.hasOwn(common, key)
          ? common[key]
          : DEVALUE_BUILTIN_TAGS.has(key)
            ? undefined
            : key === STATE_REF_REDUCER
              ? this.revive
              : key === STATE_SOURCE_REDUCER
                ? this.reviveSourceRef
                : opaque;
    const revivers = new Proxy({} as Record<string, (v: any) => unknown>, {
      get: (_t, key) => pick(key),
      has: (_t, key) => pick(key) !== undefined,
      getOwnPropertyDescriptor: (_t, key) => {
        const value = pick(key);
        return value === undefined
          ? undefined
          : { value, enumerable: true, configurable: true };
      },
    });
    parse(text, revivers);
  }
}

/** Writing references is opt-in with `WORKFLOW_STATE_REFS=1`; reading them always works. */
export function stateRefsEnabled(): boolean {
  return process.env.WORKFLOW_STATE_REFS === '1';
}

const bindings = globalSingleton(
  '@workflow/core//state-ref-contexts',
  1,
  () => ({
    globals: new WeakMap<object, StateContext>(),
    data: new WeakMap<object, StateContext>(),
  })
);
export function bindStateContext(global: object, context: StateContext): void {
  bindings.globals.set(global, context);
}
export function stateContextForGlobal(
  global: object
): StateContext | undefined {
  return bindings.globals.get(global);
}
export function bindStateContextData(
  data: unknown,
  context: StateContext | undefined
): void {
  if (data !== null && typeof data === 'object' && context)
    bindings.data.set(data, context);
}
export function stateContextForData(data: unknown): StateContext | undefined {
  return data !== null && typeof data === 'object'
    ? bindings.data.get(data)
    : undefined;
}
