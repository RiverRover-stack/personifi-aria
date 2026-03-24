/**
 * Pulse History Writer — Phase 4 (#122)
 *
 * Thin wrapper around insertPulseHistory / getRecentPulseHistory
 * from fusion-tables, providing a clean pulse-module API for
 * writing the audit trail whenever pulse state changes.
 */

export { insertPulseHistory as writePulseHistory, getRecentPulseHistory } from '../db/fusion-tables.js'
