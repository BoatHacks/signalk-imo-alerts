// No external dependencies - nothing to vendor. Uses the browser's native
// Web Speech API for browser-side playback (see docs/design.md, "Playback").
(function () {
  'use strict'

  var BASE = '/plugins/signalk-imo-alerts'
  var spokenPaths = new Set()

  function fetchActive () {
    fetch(BASE + '/active', { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.json()
      })
      .then(renderActive)
      .catch(function (err) {
        console.error('signalk-imo-alerts: failed to fetch active alerts', err)
      })
  }

  function renderActive (alerts) {
    var tbody = document.getElementById('active-alerts')
    tbody.innerHTML = ''
    alerts.forEach(function (a) {
      var tr = document.createElement('tr')
      ;['path', 'priority', 'message', 'state'].forEach(function (key) {
        var td = document.createElement('td')
        td.textContent = a[key]
        tr.appendChild(td)
      })
      tbody.appendChild(tr)

      var key = a.path + '|' + a.message
      if (a.state === 'unacknowledged' && !spokenPaths.has(key)) {
        spokenPaths.add(key)
        speak(a.message)
      }
      if (a.state !== 'unacknowledged') {
        spokenPaths.delete(key)
      }
    })
  }

  function speak (text) {
    if (!window.speechSynthesis) return
    var utterance = new SpeechSynthesisUtterance(text)
    window.speechSynthesis.speak(utterance)
  }

  document.getElementById('test-form').addEventListener('submit', function (ev) {
    ev.preventDefault()
    var priority = Number(document.getElementById('test-priority').value)
    var message = document.getElementById('test-message').value
    fetch(BASE + '/test-announce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ priority: priority, message: message })
    }).catch(function (err) {
      console.error('signalk-imo-alerts: test-announce failed', err)
    })
  })

  setInterval(fetchActive, 2000)
  fetchActive()
})()
