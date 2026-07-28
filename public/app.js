// No external dependencies - nothing to vendor. One TTS engine
// (espeak-ng, server-side) serves both local-speaker and browser
// playback: the browser fetches and plays the exact same rendered audio
// the server would speak, via /voice-clip - same pattern /tone-clip
// already uses for tones (see docs/design.md, "Voice selection").
(function () {
  'use strict'

  var BASE = '/plugins/signalk-imo-alerts'
  var spokenPaths = new Set()
  var configuredVoice = { language: '', serverVoice: '' }

  // --- shared blob-fetch-and-play helper ------------------------------------

  var objectUrls = {} // keyed by audio element id, so each element tracks its own

  function fetchAndPlay (url, audioEl, onStatus) {
    return fetch(url, { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) {
          return res
            .json()
            .catch(function () {
              return {}
            })
            .then(function (body) {
              throw new Error('HTTP ' + res.status + (body.error ? ': ' + body.error : ''))
            })
        }
        return res.blob()
      })
      .then(function (blob) {
        return new Promise(function (resolve) {
          var prior = objectUrls[audioEl.id]
          if (prior) URL.revokeObjectURL(prior)
          var objectUrl = URL.createObjectURL(blob)
          objectUrls[audioEl.id] = objectUrl
          audioEl.src = objectUrl
          audioEl.onended = resolve
          audioEl.onerror = function () {
            if (onStatus) {
              onStatus(
                'Loaded but the browser could not play it (' +
                  (audioEl.error ? audioEl.error.message : 'unknown error') +
                  ').'
              )
            }
            resolve()
          }
          var playPromise = audioEl.play()
          if (playPromise && playPromise.catch) {
            playPromise.catch(function (err) {
              if (onStatus) onStatus('Browser blocked playback: ' + err.message)
              resolve()
            })
          }
        })
      })
      .catch(function (err) {
        console.error('signalk-imo-alerts: failed to load clip from ' + url, err)
        if (onStatus) onStatus('Failed to load clip from ' + url + ' - ' + err.message)
      })
  }

  function voiceClipUrl (message, language, voice) {
    var params = new URLSearchParams()
    params.set('message', message)
    if (language) params.set('language', language)
    if (voice) params.set('voice', voice)
    return BASE + '/voice-clip?' + params.toString()
  }

  // --- Active alerts table ---------------------------------------------------

  var liveVoicePlayer = document.getElementById('live-voice-player')
  var liveTonePlayer = document.getElementById('live-tone-player')

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

  function toneClipUrlForAlert (a) {
    var params = new URLSearchParams()
    if (a.tonePattern) params.set('pattern', a.tonePattern)
    else if (a.toneCode) params.set('code', a.toneCode)
    else params.set('priority', String(a.priority))
    if (!a.tonePattern && !a.toneCode) params.set('path', a.path)
    return BASE + '/tone-clip?' + params.toString()
  }

  function postAction (action, path) {
    return fetch(BASE + '/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ path: path })
    })
      .then(function (res) { return res.json() })
      .then(function (body) {
        if (!body.ok) console.error('signalk-imo-alerts: ' + action + ' failed', body.error)
      })
      .catch(function (err) {
        console.error('signalk-imo-alerts: ' + action + ' request failed', err)
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

      var actionsTd = document.createElement('td')
      var ackButton = document.createElement('button')
      ackButton.textContent = 'Acknowledge'
      ackButton.disabled = a.state === 'acknowledged'
      ackButton.addEventListener('click', function () {
        postAction('acknowledge', a.path)
      })
      var silenceButton = document.createElement('button')
      silenceButton.textContent = 'Silence'
      silenceButton.disabled = a.state !== 'unacknowledged'
      silenceButton.addEventListener('click', function () {
        postAction('silence', a.path)
      })
      actionsTd.appendChild(ackButton)
      actionsTd.appendChild(silenceButton)
      tr.appendChild(actionsTd)

      tbody.appendChild(tr)

      // keyed by revision (the queue's own monotonic sequence number), not
      // path+message - a deliberate resubmission (e.g. clicking "Play
      // combination" again with the same test message) changes revision
      // even though path/message don't, so it still replays; a genuine
      // heartbeat (unchanged revision) correctly doesn't
      var key = a.path + '|' + a.revision
      if (a.state === 'unacknowledged' && !spokenPaths.has(key)) {
        spokenPaths.add(key)
        // tone first, then voice - same sequencing as server-side
        // announce() and test mode (see docs/design.md, "Sequencing").
        // language/voice fall back to the plugin's configured defaults
        // unless this entry has its own override (set by /test-announce
        // for a test with a specific language/voice selected).
        fetchAndPlay(toneClipUrlForAlert(a), liveTonePlayer).then(function () {
          // a.message is already pronunciation-substituted server-side
          // (resolveMessage, or applyPronunciation for a test) - play it
          // as-is, no client-side reprocessing
          if (a.message) {
            return fetchAndPlay(
              voiceClipUrl(
                a.message,
                a.language || configuredVoice.language,
                a.voice || configuredVoice.serverVoice
              ),
              liveVoicePlayer
            )
          }
        })
      }
      if (a.state !== 'unacknowledged') {
        spokenPaths.delete(key)
      }
    })
  }

  setInterval(fetchActive, 2000)
  fetchActive()

  // --- Test mode -------------------------------------------------------------

  var prioritySelect = document.getElementById('test-priority')
  var toneSelect = document.getElementById('test-tone')
  var patternRow = document.getElementById('test-pattern-row')
  var patternInput = document.getElementById('test-pattern')
  var messageInput = document.getElementById('test-message')
  var languageInput = document.getElementById('test-language')
  var voiceInput = document.getElementById('test-server-voice')
  var tonePlayer = document.getElementById('tone-player')

  var toneDefaultHint = document.getElementById('tone-default-hint')
  var priorityConfigByValue = {}
  var musterPatternByValue = {}

  fetch(BASE + '/options', { cache: 'no-store' })
    .then(function (res) { return res.json() })
    .then(function (options) {
      options.priorities.forEach(function (p) {
        var opt = document.createElement('option')
        opt.value = p.value
        opt.textContent = p.label
        prioritySelect.appendChild(opt)
        priorityConfigByValue[p.value] = p.configuredDefault
      })
      options.toneCodes.forEach(function (t) {
        var opt = document.createElement('option')
        opt.value = t.value
        opt.textContent = t.label + (t.description ? ' - ' + t.description : '')
        toneSelect.appendChild(opt)
      })
      options.musterListCodes.forEach(function (m, i) {
        var value = 'muster:' + i
        var opt = document.createElement('option')
        opt.value = value
        opt.textContent = '1.b: ' + (m.zone || m.path)
        toneSelect.appendChild(opt)
        musterPatternByValue[value] = m.pattern
      })
      updateToneDefaultHint()
      configuredVoice = options.voice || configuredVoice
      languageInput.placeholder = configuredVoice.language || 'en'
      voiceInput.placeholder = configuredVoice.serverVoice || '(language above)'
    })
    .catch(function (err) {
      console.error('signalk-imo-alerts: failed to fetch options', err)
    })

  function updateToneDefaultHint () {
    if (toneSelect.value.indexOf('muster:') === 0) {
      toneDefaultHint.textContent = '(pattern: "' + musterPatternByValue[toneSelect.value] + '")'
      return
    }
    if (toneSelect.value !== '') {
      toneDefaultHint.textContent = ''
      return
    }
    var def = priorityConfigByValue[Number(prioritySelect.value)]
    if (!def) {
      toneDefaultHint.textContent = ''
      return
    }
    toneDefaultHint.textContent =
      def.preset === 'custom'
        ? '(currently: custom pattern "' + def.pattern + '")'
        : '(currently: ' + def.preset + ')'
  }

  prioritySelect.addEventListener('change', updateToneDefaultHint)

  toneSelect.addEventListener('change', function () {
    patternRow.style.display = toneSelect.value === '__custom__' ? 'flex' : 'none'
    updateToneDefaultHint()
  })

  function currentSelection () {
    var toneValue = toneSelect.value
    var isCustom = toneValue === '__custom__'
    var isMuster = toneValue.indexOf('muster:') === 0
    return {
      priority: Number(prioritySelect.value),
      toneCode: isCustom || isMuster || toneValue === '' ? undefined : toneValue,
      tonePattern: isCustom ? patternInput.value : isMuster ? musterPatternByValue[toneValue] : undefined,
      message: messageInput.value || undefined,
      language: languageInput.value || undefined,
      voice: voiceInput.value || undefined
    }
  }

  function toneClipUrl (sel) {
    var params = new URLSearchParams()
    if (sel.tonePattern) params.set('pattern', sel.tonePattern)
    else if (sel.toneCode) params.set('code', sel.toneCode)
    else params.set('priority', String(sel.priority))
    return BASE + '/tone-clip?' + params.toString()
  }

  var statusEl = document.getElementById('test-status')

  function setStatus (text) {
    statusEl.textContent = text || ''
  }

  function playToneInBrowser (sel) {
    if (sel.toneCode === 'none') {
      return Promise.resolve()
    }
    return fetchAndPlay(toneClipUrl(sel), tonePlayer, function (msg) {
      setStatus('Tone: ' + msg)
    })
  }

  document.getElementById('test-preview').addEventListener('click', function () {
    setStatus('')
    playToneInBrowser(currentSelection())
  })

  document.getElementById('test-form').addEventListener('submit', function (ev) {
    ev.preventDefault()
    setStatus('')
    var sel = currentSelection()

    // /test-announce now pushes into the same queue real alerts.* alerts
    // use (see index.js), so playback - in this browser and any other
    // open tab alike - happens via the existing /active polling above,
    // not a separate call here. This also means a test now follows the
    // real priority-preemption/repeat/silence rules, same as a real
    // alert would.
    fetch(BASE + '/test-announce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(sel)
    })
      .then(function (res) { return res.json() })
      .then(function (body) {
        if (!body.ok) setStatus('test-announce failed: ' + (body.error || 'unknown error'))
      })
      .catch(function (err) {
        console.error('signalk-imo-alerts: test-announce failed', err)
        setStatus('test-announce request failed: ' + err.message)
      })
  })
})()
