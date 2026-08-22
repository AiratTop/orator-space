/**
 * Types for the operator scripts' id encoder.
 *
 * Hand-written because the file it describes is plain JavaScript an operator runs with
 * `node`, outside the build. It exists so that `packages/protocol/src/ids.test.ts` can hold
 * the two implementations against each other — see the comment there for why there are two.
 */
export declare function encodeId(bytes: Uint8Array): string;
export declare function newId(at?: Date): string;
