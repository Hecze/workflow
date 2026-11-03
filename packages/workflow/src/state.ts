/**
 * Immutable state with an immer-style `produce`, for values passed between steps.
 *
 * @example
 * ```ts
 * import { produce, type Immutable } from 'workflow/state';
 *
 * async function addMessage(history: Immutable<Message[]>, message: Message) {
 *   'use step';
 *   return produce(history, (draft) => {
 *     draft.push(message);
 *   });
 * }
 * ```
 */
export { type Draft, type Immutable, produce } from '@workflow/core/state';
