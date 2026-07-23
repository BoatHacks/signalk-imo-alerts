'use strict'

// Formats a raw SI value for speech using the path's own Signal K
// displayUnits meta (delivered via subscribe with sendMeta:'all'), so the
// spoken unit always matches whatever the admin UI has configured - see
// docs/design.md, "Message templates" / numeric interpolation.
//
// Expected shape of displayUnits, as delivered in delta meta:
//   { formula, targetUnit, symbol, displayFormat }
// `formula` is a simple arithmetic expression over the identifier `value`,
// e.g. "value * 1.94384" (m/s -> knots) or "value - 273.15" (K -> degC).

function formatValueForSpeech (rawValue, displayUnits) {
  if (typeof rawValue !== 'number' || Number.isNaN(rawValue)) {
    return null
  }
  if (!displayUnits || !displayUnits.formula) {
    // No meta available - speak the raw SI value as-is.
    return `${roundForSpeech(rawValue)}`
  }

  const converted = evaluateFormula(displayUnits.formula, rawValue)
  const rounded = applyDisplayFormat(converted, displayUnits.displayFormat)
  const symbol = displayUnits.symbol ? ` ${displayUnits.symbol}` : ''
  return `${rounded}${symbol}`
}

function evaluateFormula (formula, value) {
  // Deliberately restrictive: only arithmetic on `value` is permitted.
  // No plugin-supplied config ever reaches this - only server-delivered
  // meta - but keep the expression surface minimal regardless.
  if (!/^[0-9+\-*/().\s]*value[0-9+\-*/().\s]*$/.test(formula.replace(/value/g, ''))) {
    // formula contains something other than arithmetic + 'value' -> bail out safely
    return value
  }
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('value', `return (${formula});`)
    const result = fn(value)
    return typeof result === 'number' && !Number.isNaN(result) ? result : value
  } catch {
    return value
  }
}

function applyDisplayFormat (value, displayFormat) {
  const precisionMatch = /%\.(\d+)f/.exec(displayFormat || '')
  const precision = precisionMatch ? Number(precisionMatch[1]) : 1
  return roundForSpeech(value, precision)
}

function roundForSpeech (value, precision = 1) {
  return Number(value.toFixed(precision))
}

module.exports = {
  formatValueForSpeech
}
