// No external dependencies - nothing to vendor. Uses the browser's native
// Web Speech API and <audio> element for browser-side playback (see
// docs/design.md, "Playback").
(function () {
  'use strict'

  var BASE = '/plugins/signalk-imo-alerts'
  var spokenPaths = new Set()

  // --- Active alerts table -------------------------------------------------

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

  function speak (text, language) {
    if (!window.speechSynthesis || !text) return
    var utterance = new SpeechSynthesisUtterance(text)
    if (language) utterance.lang = language
    window.speechSynthesis.speak(utterance)
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
        opt.textContent = t.label
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
      language: languageInput.value || undefined
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
  var currentObjectUrl = null

  function setStatus (text) {
    statusEl.textContent = text || ''
  }

  function playToneInBrowser (sel) {
    if (sel.toneCode === 'none') {
      return Promise.resolve()
    }

    var url = toneClipUrl(sel)
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
          if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl)
          currentObjectUrl = URL.createObjectURL(blob)
          tonePlayer.src = currentObjectUrl
          tonePlayer.onended = resolve
          tonePlayer.onerror = function () {
            setStatus('Tone loaded but the browser could not play it (' + (tonePlayer.error ? tonePlayer.error.message : 'unknown error') + ').')
            resolve()
          }
          var playPromise = tonePlayer.play()
          if (playPromise && playPromise.catch) {
            playPromise.catch(function (err) {
              setStatus('Browser blocked tone playback: ' + err.message)
              resolve()
            })
          }
        })
      })
      .catch(function (err) {
        console.error('signalk-imo-alerts: failed to load tone clip', err)
        setStatus('Failed to load tone clip from ' + url + ' - ' + err.message)
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

    // browser-side: play tone then speak, immediately
    playToneInBrowser(sel).then(function () {
      speak(sel.message, sel.language)
    })

    // server-side (if enabled in plugin config, exercises the real
    // espeak-ng/aplay path on the Signal K host)
    fetch(BASE + '/test-announce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(sel)
    }).catch(function (err) {
      console.error('signalk-imo-alerts: test-announce failed', err)
    })
  })
})()
