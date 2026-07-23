'use strict'

// MSC.302(87) priority tiers, ordered lowest to highest.
// 'alert' has no BAM equivalent and is never voiced (see docs/design.md).
const PRIORITY = Object.freeze({
  NONE: 0, // signalk 'alert' state - not voiced
  CAUTION: 1, // signalk 'warn'
  WARNING: 2, // signalk 'alarm'
  ALARM: 3, // signalk 'emergency'
  EMERGENCY_ALARM: 4 // pinned paths only, regardless of signalk state
})

const PRIORITY_NAME = Object.freeze({
  [PRIORITY.CAUTION]: 'Caution',
  [PRIORITY.WARNING]: 'Warning',
  [PRIORITY.ALARM]: 'Alarm',
  [PRIORITY.EMERGENCY_ALARM]: 'Emergency alarm'
})

const SIGNALK_STATE_TO_PRIORITY = Object.freeze({
  nominal: PRIORITY.NONE,
  normal: PRIORITY.NONE,
  alert: PRIORITY.NONE,
  warn: PRIORITY.CAUTION,
  alarm: PRIORITY.WARNING,
  emergency: PRIORITY.ALARM
})

/**
 * Resolve the MSC.302(87) priority for a notification.
 *
 * @param {string} path - the full Signal K path, e.g. "notifications.mob"
 * @param {string} state - the Signal K notification state string
 * @param {string[]} pinnedEmergencyAlarmPaths - configurable list of paths
 *   (exact match or simple glob with trailing '*') that are always treated
 *   as MSC.302(87) Emergency Alarm regardless of their Signal K state.
 * @returns {number} one of the PRIORITY values
 */
function resolvePriority (path, state, pinnedEmergencyAlarmPaths = []) {
  if (isPinned(path, pinnedEmergencyAlarmPaths)) {
    return PRIORITY.EMERGENCY_ALARM
  }
  return SIGNALK_STATE_TO_PRIORITY[state] ?? PRIORITY.NONE
}

function isPinned (path, pinnedPaths) {
  return pinnedPaths.some((pattern) => {
    if (pattern.endsWith('*')) {
      return path.startsWith(pattern.slice(0, -1))
    }
    return path === pattern
  })
}

function shouldVoice (priority) {
  return priority > PRIORITY.NONE
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
