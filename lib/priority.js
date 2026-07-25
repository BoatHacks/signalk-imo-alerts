'use strict'

// MSC.302(87) priority tiers, ordered lowest to highest.
const PRIORITY = Object.freeze({
  CAUTION: 1,
  WARNING: 2,
  ALARM: 3,
  EMERGENCY_ALARM: 4
})

const PRIORITY_NAME = Object.freeze({
  [PRIORITY.CAUTION]: 'Caution',
  [PRIORITY.WARNING]: 'Warning',
  [PRIORITY.ALARM]: 'Alarm',
  [PRIORITY.EMERGENCY_ALARM]: 'Emergency alarm'
})

// signalk-alert-manager's own priority field already maps directly onto
// MSC.302(87) tiers - see docs/alerts-only-plan.md. This replaces the old
// notifications.*-state-based inference (SIGNALK_STATE_TO_PRIORITY) and the
// pinnedEmergencyAlarmPaths hack that used to exist because Signal K's
// notification states have no genuine top tier of their own: alert
// manager's 'emergency' priority already means exactly that, explicitly,
// at the source - no inference or per-path pinning needed anymore.
const ALERT_MANAGER_PRIORITY_TO_PRIORITY = Object.freeze({
  caution: PRIORITY.CAUTION,
  warning: PRIORITY.WARNING,
  alarm: PRIORITY.ALARM,
  emergency: PRIORITY.EMERGENCY_ALARM
})

/**
 * Resolve the MSC.302(87) priority for an alerts.* delta.
 *
 * @param {string} alertPriority - alert manager's own priority field:
 *   'caution' | 'warning' | 'alarm' | 'emergency'
 * @returns {number|null} one of the PRIORITY values, or null if the
 *   priority string is missing or unrecognized. A malformed/unknown
 *   priority should be ignored by the caller (see docs/alerts-only-plan.md,
 *   "Heartbeat dedup" - alert manager itself silently ignores alerts.*
 *   deltas with an invalid priority; this plugin does the same rather
 *   than guessing).
 */
function resolvePriority (alertPriority) {
  return ALERT_MANAGER_PRIORITY_TO_PRIORITY[alertPriority] ?? null
}

function shouldVoice (priority) {
  return priority !== null && priority !== undefined
}

function priorityName (priority) {
  return PRIORITY_NAME[priority] || null
}

module.exports = {
  PRIORITY,
  resolvePriority,
  shouldVoice,
  priorityName
}
