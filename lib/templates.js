'use strict'

const { priorityName } = require('./priority')

/**
 * @param {object} params
 * @param {string} params.path - alert's own path (alerts.<path> with the
 *   'alerts.' prefix already stripped, matching alert manager's own
 *   convention)
 * @param {number} params.priority - PRIORITY value
 * @param {object} params.alert - the alerts.* delta value object, e.g.
 *   { message, state, group, data, ... } - see docs/alerts-only-plan.md
 *   for the full shape. `message` is required by alert manager's own
 *   contract, so there's no humanizePath-style fallback needed here
 *   (unlike the old notifications.*-based version this replaced, where
 *   `.message` could be absent).
 * @param {Array<{pathPattern: string, template: string}>} [params.overrides]
 * @param {Array<{pattern: string, replacement: string}>} [params.pronunciation]
 * @param {{useDistinctPhrase: boolean, phrase?: string}} [params.rtnPhrasing]
 *   - only consulted when alert.state === 'rtn-unacknowledged'; per-priority
 *   config for whether to repeat the original message or speak a distinct
 *   "condition cleared" phrase - see docs/alerts-only-plan.md, Decision 2.
 * @returns {string} final spoken text, ready for TTS
 */
function resolveMessage ({ path, priority, alert, overrides = [], pronunciation = [], rtnPhrasing }) {
  const prefix = priorityName(priority)
  const override = overrides.find((o) => matchesPath(path, o.pathPattern))

  let body
  if (alert.state === 'rtn-unacknowledged' && rtnPhrasing && rtnPhrasing.useDistinctPhrase) {
    body = rtnPhrasing.phrase || 'Condition cleared, please acknowledge'
  } else if (override) {
    body = interpolate(override.template, { path, alert })
  } else {
    body = alert.message
  }

  const text = `${prefix}. ${body}.`
  return applyPronunciation(text, pronunciation)
}

function matchesPath (path, pattern) {
  if (pattern.endsWith('*')) {
    return path.startsWith(pattern.slice(0, -1))
  }
  return path === pattern
}

function interpolate (template, ctx) {
  return template.replace(/\{(\w+(?:\.\w+)*)\}/g, (_, ref) => {
    if (ref === 'path') return ctx.path
    const parts = ref.split('.')
    let cur = ctx.alert
    for (const p of parts) {
      if (cur == null) break
      cur = cur[p]
    }
    return cur ?? ''
  })
}

function applyPronunciation (text, substitutions) {
  return substitutions.reduce((acc, { pattern, replacement }) => {
    try {
      return acc.replace(new RegExp(pattern, 'gi'), replacement)
    } catch {
      // invalid user-supplied regex - skip rather than throw
      return acc
    }
  }, text)
}

module.exports = {
  resolveMessage,
  applyPronunciation
}
