'use strict'

/**
 * Wires acknowledge/silence actions to real Signal K mechanisms, mirroring
 * the reconciliation approach used in signalk-dead-mans-switch:
 *  - a PUT handler per active notification path, accepting
 *    { action: 'acknowledge' | 'silence' }
 *  - a poll fallback (app.getSelfPath) for actions/sources that don't
 *    emit a delta at all
 *
 * Delta-based detection (the notification's own status.acknowledged /
 * method fields, e.g. from Freeboard-style clients) is handled separately
 * in index.js's handleNotification, since that arrives through the normal
 * subscription already in place.
 *
 * @param {object} app - the Signal K plugin app object
 * @param {object} opts
 * @param {string} opts.pluginId
 * @param {() => import('./alertQueue').AlertQueue} opts.getQueue
 * @param {number} [opts.pollIntervalMs]
 */
function createAckListener (app, { pluginId, getQueue, pollIntervalMs = 2000 }) {
  const registeredPaths = new Set()
  let pollInterval = null

  function ensurePutHandlerRegistered (path) {
    if (registeredPaths.has(path)) return
    registeredPaths.add(path)

    app.registerPutHandler(
      'vessels.self',
      path,
      (context, putPath, value) => {
        const queue = getQueue()
        if (!queue) {
          return { state: 'COMPLETED', statusCode: 503 }
        }
        if (value && value.action === 'acknowledge') {
          queue.acknowledge(putPath)
        } else if (value && value.action === 'silence') {
          queue.silence(putPath)
        }
        return { state: 'COMPLETED', statusCode: 200 }
      },
      pluginId
    )
  }

  function pollOnce (activePaths) {
    const queue = getQueue()
    if (!queue) return
    for (const path of activePaths) {
      app.getSelfPath &&
        Promise.resolve(app.getSelfPath(path))
          .then((notification) => {
            if (!notification) return
            // same heuristic as the delta path in index.js: "sound" no
            // longer present in method is treated as an ack-equivalent
            // signal, in case this particular update never emitted a delta
            if (notification.method && !notification.method.includes('sound')) {
              queue.acknowledge(path)
            }
          })
          .catch(() => {
            // path may not exist as a plain getSelfPath target on every
            // signalk-server version - non-fatal, delta subscription is
            // still the primary detection mechanism
          })
    }
  }

  /** Call whenever the set of active alert paths may have changed. */
  function syncPaths (activePaths) {
    for (const path of activePaths) {
      ensurePutHandlerRegistered(path)
    }
  }

  function startPolling (getActivePaths) {
    pollInterval = setInterval(() => pollOnce(getActivePaths()), pollIntervalMs)
  }

  function stop () {
    if (pollInterval) clearInterval(pollInterval)
    pollInterval = null
    registeredPaths.clear()
  }

  return { syncPaths, startPolling, stop }
}

module.exports = { createAckListener }
