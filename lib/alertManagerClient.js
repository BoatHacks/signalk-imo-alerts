'use strict'

/**
 * Thin client for signalk-alert-manager's REST API. This exists because
 * the plugin API it also documents (app.alertManager) is structurally
 * unreachable from other plugins - signalk-server gives every plugin its
 * own separate copy of the app object, so alert manager's `app.alertManager
 * = api` inside its own start() is invisible to us. Confirmed live and
 * independently upstream - see docs/alerts-only-plan.md and
 * hatlabs/signalk-alert-manager#104/#106.
 *
 * All of alert manager's REST routes require the server's normal admin
 * auth (a Bearer token) - there's no in-process bypass for same-server
 * requests. The token has to be generated once by the user (Admin UI ->
 * Security -> Devices, or the signalk-generate-token CLI) and configured
 * in this plugin's own settings (alertManagerToken).
 */

/**
 * @param {object} opts
 * @param {number} opts.port - local HTTP port to call (same server)
 * @param {string} opts.token - Bearer token for alert manager's REST API
 * @param {typeof fetch} [opts.fetchFn] - injectable for tests
 */
function createClient ({ port, token, fetchFn = fetch }) {
  const baseUrl = `http://localhost:${port}/plugins/signalk-alert-manager`

  async function post (path, body) {
    if (!token) {
      return { ok: false, status: 400, error: 'no alertManagerToken configured (see plugin.schema)' }
    }
    let res
    try {
      res = await fetchFn(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: body ? JSON.stringify(body) : undefined
      })
    } catch (err) {
      return { ok: false, status: 503, error: `could not reach signalk-alert-manager: ${err.message}` }
    }
    if (!res.ok) {
      let detail = ''
      try {
        detail = await res.text()
      } catch {
        // ignore - detail stays empty
      }
      return { ok: false, status: res.status, error: `alert manager returned ${res.status}${detail ? `: ${detail}` : ''}` }
    }
    return { ok: true, status: res.status }
  }

  return {
    acknowledgeAlert: (id) => post(`/alerts/${id}/acknowledge`),
    // alert manager's REST API takes seconds (unlike the unreachable
    // plugin API, which takes milliseconds) - see README, "Silence"
    silenceAlert: (id, durationSeconds) =>
      post(`/alerts/${id}/silence`, typeof durationSeconds === 'number' ? { duration: durationSeconds } : undefined)
  }
}

module.exports = { createClient }
