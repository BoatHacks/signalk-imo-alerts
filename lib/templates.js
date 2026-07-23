'use strict'

const { priorityName } = require('./priority')
const { formatValueForSpeech } = require('./units')

// Generic fallback: "{priority}. {plain-language path description}."
// A humanized path description is used when no override matches.
function humanizePath (path) {
  return path
    .replace(/^notifications\./, '')
    .split('.')
    .join(' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
}

/**
 * @param {object} params
 * @param {string} params.path - full notification path
 * @param {number} params.priority - PRIORITY value
 * @param {object} params.notification - the raw Signal K notification value
 *   ({ state, message, ... })
 * @param {number} [params.rawValue] - numeric value to interpolate, if any
 * @param {object} [params.displayUnits] - meta.displayUnits for rawValue's path
 * @param {Array<{pathPattern: string, template: string}>} [params.overrides]
 * @param {Array<{pattern: string, replacement: string}>} [params.pronunciation]
 * @returns {string} final spoken text, ready for TTS
 */
function resolveMessage ({
  path,
  priority,
  notification,
  rawValue,
  displayUnits,
  overrides = [],
  pronunciation = []
}) {
  const prefix = priorityName(priority)
  const override = overrides.find((o) => matchesPath(path, o.pathPattern))

  const interpolatedValue =
    typeof rawValue === 'number' ? formatValueForSpeech(rawValue, displayUnits) : null

  let body
  if (override) {
    body = interpolate(override.template, { path, notification, value: interpolatedValue })
  } else {
    const description = (notification && notification.message) || humanizePath(path)
    body = interpolatedValue ? `${description}: ${interpolatedValue}` : description
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
    if (ref === 'value') return ctx.value ?? ''
    if (ref === 'path') return ctx.path
    const parts = ref.split('.')
    let cur = ctx.notification
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
  humanizePath
}
