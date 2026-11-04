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
 *
 * Only versions a reader of the log can see are referenceable: step outputs,
 * and the hook payloads and run input registered with `addSource`. Step inputs
 * are never read back (replay and recovery skip them), so the versions a step
 * input carries are not remembered on either side.
 *
 * Hook payloads and run inputs keep their usual format. Each reader knows the
 * event a payload came from and registers its strings under that event's id
 * (see `stateSourceId`), so a runtime without this module reads them as before.
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
  /** The value's measured size, and `bytesSinceFull` when it was measured. */
  readonly measured?: Measured;
}
interface Measured {
  readonly bytes: number;
  readonly at: number;
}

/**
 * A record refers to a version, base or source this context has not seen: the
 * log it was rebuilt from is missing what the writer saw.
 */
export class WorkflowStateMissingError extends Error {
  override name = 'WorkflowStateMissingError';
}

/** The id a reader registers a payload's strings under (see `addSource`). */
export function stateSourceId(
  event: { eventType: string; eventId?: string } | 'run-input'
): string | undefined {
  if (event === 'run-input') return 'run';
  return event.eventType === 'hook_received' && event.eventId
    ? `hook:${event.eventId}`
    : undefined;
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
  // slice(), not spread: holes in a sparse array must stay holes.
  if (Array.isArray(value)) return value.slice();
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
    recoveryBytes: 0,
    recoveryMs: 0,
  };

  /** devalue reducer: returns a record for tracked values, `false` otherwise. */
  reduce = (value: unknown): unknown => this.reduceValue(value, true);

  /**
   * devalue reducer for a step input. Its versions are written like any
   * other, but not remembered: no reader reads step inputs back, so a later
   * payload must not refer to them.
   */
  reduceInput = (value: unknown): unknown => this.reduceValue(value, false);

  private reduceValue(value: unknown, register: boolean): unknown {
    if (value === null || typeof value !== 'object') return false;
    // Writing references is opt-in; reading them is always supported, so runs
    // that stored references stay readable after the setting is turned off.
    const lineage = lineageOf(value);
    return lineage === undefined || !stateRefsEnabled()
      ? false
      : this.reduceTracked(value, lineage, register);
  }

  /** devalue reducer for the strings inside a state change that a source already holds. */
  reduceSourceRef = (value: unknown): unknown =>
    value instanceof StateSourceRef ? [value.id, value.path] : false;

  reviveSourceRef = ([id, path]: [
    string,
    (string | number)[],
  ]): StateSourceRef =>
    new StateSourceRef(checkedId(id, 'state source id'), path);

  revive = (d: Dict): unknown => this.reviveRecord(d, true);

  /** devalue reviver for a step input: rebuilds its values without remembering them (see `reduceInput`). */
  reviveInput = (d: Dict): unknown => this.reviveRecord(d, false);

  private reviveRecord(d: Dict, register: boolean): unknown {
    switch (d.kind) {
      case 'source':
        // Written by earlier previews of this feature; still readable.
        return this.reviveSource(d);
      case 'ref':
      case 'patch':
      case 'full':
        return this.reviveTracked(d, register);
      default:
        throw new Error('Unknown workflow state record');
    }
  }

  private reduceTracked(
    value: unknown,
    lineage: StateLineage,
    register: boolean
  ): unknown {
    const { logId, version } = lineage;
    if (this.versions.get(version)?.logId === logId) {
      this.stats.refs++;
      return { kind: 'ref', logId, version };
    }
    const base =
      lineage.base === undefined ? undefined : this.versions.get(lineage.base);
    const { snapshot, measured } = this.snapshotRule(
      value,
      lineage.bytesSinceFull,
      base?.logId === logId ? base.measured : undefined
    );
    // A change that replaces the whole value is stored as that value: its
    // `set` would otherwise hold the value itself, which devalue would encode
    // as a reference back to this record.
    const replacesWhole =
      lineage.ops?.some((op) => op.op === 'set' && op.path.length === 0) ??
      false;
    if (
      base?.logId === logId &&
      lineage.ops !== undefined &&
      !snapshot &&
      !replacesWhole
    ) {
      if (register)
        this.versions.set(version, {
          logId,
          value,
          bytesSinceFull: lineage.bytesSinceFull,
          measured,
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
    if (register)
      this.versions.set(version, {
        logId,
        value,
        bytesSinceFull: 0,
        measured: measured && { bytes: measured.bytes, at: 0 },
      });
    this.stats.full++;
    return { kind: 'full', logId, version, value: shallowCopy(value) };
  }

  /**
   * Whether to write the value whole: its changes since the last whole value
   * exceed {@link SNAPSHOT_MIN_BYTES} and twice its size. Measuring the size
   * serializes the whole value, so a measurement is reused while the changes
   * since it cannot have shrunk the value enough for the rule to fire.
   */
  private snapshotRule(
    value: unknown,
    bytesSinceFull: number,
    measured: Measured | undefined
  ): { snapshot: boolean; measured: Measured | undefined } {
    if (bytesSinceFull <= SNAPSHOT_MIN_BYTES)
      return { snapshot: false, measured };
    if (measured !== undefined && bytesSinceFull >= measured.at) {
      // Each change moves the size by about its own bytes, so the value is
      // at least this big; while the rule can't fire against that, skip it.
      const atLeast = measured.bytes - (bytesSinceFull - measured.at);
      if (bytesSinceFull <= 2 * atLeast) return { snapshot: false, measured };
    }
    const bytes = jsonBytes(value);
    return {
      snapshot: bytesSinceFull > 2 * bytes,
      measured: { bytes, at: bytesSinceFull },
    };
  }

  private reviveTracked(d: Dict, register: boolean): unknown {
    const logId = checkedId(d.logId, 'workflow state log');
    const version = checkedId(d.version, 'workflow state version');
    const known = this.versions.get(version);
    if (d.kind === 'ref') {
      if (known?.logId !== logId)
        throw new WorkflowStateMissingError(
          `Missing workflow state version ${logId}:${version}`
        );
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
        throw new WorkflowStateMissingError(
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
    if (register) this.versions.set(version, { logId, value, bytesSinceFull });
    if (value !== null && typeof value === 'object')
      setLineage(value, { logId, version, bytesSinceFull });
    return value;
  }

  /**
   * Registers the long strings of a payload later state may refer to: a hook
   * payload or the run input, as read, under its `stateSourceId`. Every
   * reader of the log registers the same payloads under the same ids.
   */
  addSource(id: string, value: unknown): void {
    checkedId(id, 'state source id');
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
        throw new WorkflowStateMissingError(
          `Missing workflow state source ${v.id}`
        );
      const value = captured.get(JSON.stringify(v.path));
      if (value === undefined)
        throw new WorkflowStateMissingError(
          'Missing workflow state source field'
        );
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
  ingest(payload: Uint8Array, source?: string): void {
    const text = new TextDecoder().decode(payload);
    if (source === undefined && !text.includes(STATE_REF_REDUCER)) return;
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
    const value = parse(text, revivers);
    if (source !== undefined) this.addSource(source, value);
  }

  /**
   * Whether reading this decoded payload needs records this context lacks.
   * Reads it like `ingest`, into a scratch copy, so nothing is remembered.
   */
  needsRecovery(payload: Uint8Array): boolean {
    const text = new TextDecoder().decode(payload);
    if (!text.includes(STATE_REF_REDUCER)) return false;
    const scratch = new StateContext();
    for (const [id, version] of this.versions)
      scratch.versions.set(id, version);
    for (const [id, strings] of this.sources) scratch.sources.set(id, strings);
    try {
      scratch.ingest(payload);
      return false;
    } catch (error) {
      return error instanceof WorkflowStateMissingError;
    }
  }
}

/** Writing references is opt-in with `WORKFLOW_STATE_REFS=1`; reading them always works. */
export function stateRefsEnabled(): boolean {
  // The QuickJS workflow VM decodes payloads with its own codec, which does not
  // read state records yet, so references are not written for it.
  return (
    process.env.WORKFLOW_STATE_REFS === '1' &&
    process.env.WORKFLOW_VM !== 'quickjs'
  );
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
/** Registers a payload replay just read with the session's context (see `addSource`). */
export function registerStateSource(
  global: object,
  source: string | undefined,
  value: unknown
): void {
  if (source !== undefined)
    bindings.globals.get(global)?.addSource(source, value);
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

/** Span attributes for reading a step input: what rebuilding its state cost. */
export function stateHydrateAttributes(
  context: StateContext | undefined
): Record<string, number> {
  if (context === undefined) return {};
  const { recoveryFetches, recoveryBytes, recoveryMs } = context.stats;
  return {
    'workflow.state_refs.recovery_fetches': recoveryFetches,
    'workflow.state_refs.recovery_bytes': recoveryBytes,
    'workflow.state_refs.recovery_ms': recoveryMs,
  };
}

type WriteCounts = Pick<
  StateContext['stats'],
  'refs' | 'patches' | 'full' | 'sourceRefs'
>;

/** The context's write counts so far, to diff against after one write. */
export function stateWriteCounts(
  context: StateContext | undefined
): WriteCounts | undefined {
  if (context === undefined) return undefined;
  const { refs, patches, full, sourceRefs } = context.stats;
  return { refs, patches, full, sourceRefs };
}

/** Span attributes for writing a step output: the records it was stored as. */
export function stateDehydrateAttributes(
  context: StateContext | undefined,
  before: WriteCounts | undefined
): Record<string, number> {
  const after = stateWriteCounts(context);
  if (after === undefined || before === undefined) return {};
  return {
    'workflow.state_refs.refs': after.refs - before.refs,
    'workflow.state_refs.patches': after.patches - before.patches,
    'workflow.state_refs.full': after.full - before.full,
    'workflow.state_refs.source_refs': after.sourceRefs - before.sourceRefs,
  };
}
