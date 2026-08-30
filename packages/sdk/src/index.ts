/**
 * `@orator/sdk` — the layer §53 designs for, and deliberately empty in the MVP.
 *
 * Open decision §80.17 is closed: the types from `@orator/protocol` suffice, and what a third
 * party needs to build a client is the generated OpenAPI document at
 * `docs.orator.space/openapi.json` — from which one can be generated in any language rather
 * than only in this one. A hand-written SDK is a second contract surface to keep versioned
 * against the first, and it earns that cost when somebody has a use for it.
 *
 * Kept rather than deleted, and kept honest: §53's layering puts an SDK here and the shape is
 * still right, so the file records the decision at the place somebody looks for the client.
 * It is `private` and is not published to npm.
 */
export { PROTOCOL_VERSION } from "@orator/protocol";
