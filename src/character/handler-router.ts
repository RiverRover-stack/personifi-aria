/**
 * Handler Router — Unit 9 (Phase 6A)
 *
 * The Alpha/Legacy feature-flag split has been retired. handler.ts is now the
 * single canonical handler (the fully-fused Alpha pipeline). This file is kept
 * as a transparent re-export so all existing import sites continue to work
 * without changes.
 *
 * Deleted: handler-alpha.ts, handler-legacy.ts (Unit 9)
 */

export { handleMessage, type MessageResponse, type HandleMessageOptions } from './handler.js'
