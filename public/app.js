const modes = {
  bt: {
    label: 'bluetooth',
    airMs: 6, retryMs: 3.75, maxTries: 8, inOrder: true, nCh: 79, chWidth: 1, targetMs: 150,
    codecs: [
      { name: 'sbc 328 kbps', kbps: 328, frameMs: 20 },
      { name: 'aac 256 kbps', kbps: 256, frameMs: 21.33 },
      { name: 'ldac 990 kbps', kbps: 990, frameMs: 20 }
    ],
    hint: 'classic a2dp. resends a packet until it gets through and everything behind it waits, so it rarely drops audio but needs a big buffer',
    call: { frameMs: 7.5, airMs: 2.5, retryMs: 1.25, maxTries: 2, inOrder: false, sizeScale: 0.4, variant: 1 },
    callTarget: 40,
    callHint: 'a2dp cant carry a mic so it switches to hfp. music turns into mono phone quality with almost no retries'
  },
  le: {
    label: 'le audio',
    airMs: 4, retryMs: 2.5, maxTries: 4, inOrder: false, nCh: 37, chWidth: 2, targetMs: 40,
    codecs: [
      { name: 'lc3 10 ms frames', kbps: 160, frameMs: 10 },
      { name: 'lc3 7.5 ms frames', kbps: 160, frameMs: 7.5 }
    ],
    hint: 'lc3 over an isochronous channel. fixed retry budget per frame, lower delay, drops a frame when the budget runs out',
    call: { variant: 2 },
    callTarget: 40,
    callHint: 'stays on lc3 with a two way stream, audio drops to mono 32 khz'
  },
  dongle: {
    label: 'dongle',
    airMs: 1.5, retryMs: 0.625, maxTries: 3, inOrder: false, nCh: 40, chWidth: 2, targetMs: 15,
    codecs: [
      { name: '2.5 ms frames', kbps: 256, frameMs: 2.5 },
      { name: '5 ms frames', kbps: 256, frameMs: 5 }
    ],
    hint: 'custom 2.4ghz tdma link to a usb dongle. tiny frames in fixed slots, lowest delay, pairing done at the factory',
    call: null,
    callHint: 'the mic gets its own slot so game audio keeps full quality'
  }
}

const steps = {
  bt: {
    pair: ['inquiry found linklab headset', 'paging', 'acl connection complete handle 0x000b', 'ssp io capability no input no output', 'just works confirmation', 'link key stored', 'avdtp discover', 'avdtp set configuration', 'avdtp open', 'avdtp start'],
    reconnect: ['paging', 'acl connection complete handle 0x000b', 'authenticated with stored link key', 'avdtp open', 'avdtp start']
  },
  le: {
    pair: ['scan found linklab headset', 'le connection complete', 'smp pairing request secure connections', 'ltk generated', 'encryption on', 'gatt discover pacs ascs', 'ase config codec lc3', 'ase config qos', 'cis established', 'ase enabling'],
    reconnect: ['le connection complete', 'encryption on with stored ltk', 'ase config codec lc3', 'cis established', 'ase enabling']
  },
  dongle: {
    reconnect: ['dongle beacon heard', 'synced to slot clock', 'slot assigned']
  }
}

const scenes = {
  quiet: { interference: 0, noise: 'wifi1', distance: 2, ppm: 0 },
  office: { interference: 0.5, noise: 'wifi1', distance: 3 },
  apartment: { interference: 0.6, noise: 'wifi3', distance: 4 },
  microwave: { interference: 0.8, noise: 'microwave', distance: 3 },
  clock: { ppm: 4000 }
}

const $ = id => document.getElementById(id)

let mode = 'bt'
let codec = 0
let call = false
let headsetOn = false
let conn = 'off'
let runToken = 0
const bonded = new Set(['dongle'])

let ctx = null
let node = null
let gain = null
let srcKind = 'music'
const srcCache = {}

const cfg = {
  interference: 0, distance: 2, noise: 'wifi1', afh: true, ppm: 0, targetMs: 150,
  asrc: true, plc: true, bypass: false, linkUp: false
}

let last = null
let lastWall = 0
let prev = null
let packets = []
let bufHist = []
let marks = []
let chRate = null
let chOff = null
let shownMax = 300
let bufHover = -1
let specHover = -1
let linkStart = 0
let window1 = null
let walkStart = 0
let tileWall = 0
let gen = 0

function linkCfg() {
  const m = modes[mode]
  const c = m.codecs[codec]
  const o = {
    frameMs: c.frameMs, airMs: m.airMs, retryMs: m.retryMs, maxTries: m.maxTries, inOrder: m.inOrder,
    nCh: m.nCh, chWidth: m.chWidth, variant: 0,
    sizeScale: Math.max(0.4, Math.min(3, c.kbps * c.frameMs / 6560))
  }
  if (call && m.call) Object.assign(o, m.call)
  return o
}

function post(extra, reset) {
  Object.assign(cfg, extra)
  if (node) node.port.postMessage({ type: 'cfg', cfg, reset: !!reset })
}

function restream() {
  post(linkCfg(), true)
}

function log(text, kind) {
  const el = $('log')
  const row = document.createElement('div')
  if (kind) row.className = kind
  row.append(((performance.now() - linkStart) / 1000).toFixed(3) + '  ')
  const b = document.createElement('b')
  b.textContent = text
  row.append(b)
  const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 4
  el.appendChild(row)
  while (el.childElementCount > 300) el.firstChild.remove()
  if (stick) el.scrollTop = el.scrollHeight
}

function setConn(next, text) {
  conn = next
  $('connText').textContent = text
  $('connDot').className = next === 'up' ? 'up' : next === 'busy' ? 'busy' : ''
  $('power').textContent = headsetOn ? 'power off' : 'power on'
  $('pair').disabled = !(headsetOn && conn === 'adv' && mode !== 'dongle' && !bonded.has(mode))
  $('forget').disabled = !(mode !== 'dongle' && bonded.has(mode))
  post({ linkUp: next === 'up' })
}

function failChance() {
  const d = Math.max(0, (cfg.distance - 6) / 14)
  return Math.min(0.9, 0.02 + d * d * 0.9 + cfg.interference * 0.3)
}

function runSteps(list, done) {
  const token = ++runToken
  let i = 0
  let fails = 0
  const next = () => {
    if (token !== runToken) return
    if (i >= list.length) return done(true)
    if (Math.random() < failChance()) {
      fails++
      if (fails > 3) {
        log(list[i] + ' failed giving up', 'bad')
        return done(false)
      }
      log(list[i] + ' timed out retrying', 'warn')
      setTimeout(next, 300 + Math.random() * 200)
      return
    }
    fails = 0
    log(list[i])
    i++
    setTimeout(next, 120 + Math.random() * 220)
  }
  setTimeout(next, 200)
}

function later(fn, ms) {
  const token = runToken
  setTimeout(() => {
    if (token === runToken) fn()
  }, ms)
}

function connect() {
  if (!headsetOn) return
  if (!bonded.has(mode)) {
    setConn('adv', mode === 'le' ? 'advertising waiting for pair' : 'discoverable waiting for pair')
    log(mode === 'le' ? 'le advertising started' : 'inquiry scan enabled discoverable')
    return
  }
  setConn('busy', 'connecting')
  runSteps(steps[mode].reconnect, ok => {
    if (!ok) {
      setConn('busy', 'retrying soon')
      later(connect, 1500)
      return
    }
    log('streaming', 'good')
    setConn('up', 'connected streaming')
  })
}

function pair() {
  if (conn !== 'adv') return
  setConn('busy', 'pairing')
  runSteps(steps[mode].pair, ok => {
    if (!ok) {
      log('pairing failed', 'bad')
      setConn('adv', 'pairing failed try again')
      return
    }
    bonded.add(mode)
    log('bonded and streaming', 'good')
    setConn('up', 'connected streaming')
  })
}

function power() {
  headsetOn = !headsetOn
  runToken++
  if (!headsetOn) {
    log('headset powered off')
    setConn('off', 'headset off')
    return
  }
  log('headset powered on')
  connect()
}

function forget() {
  bonded.delete(mode)
  runToken++
  log('bond removed keys deleted')
  if (headsetOn) connect()
  else setConn('off', 'headset off')
}

function linkLost() {
  runToken++
  log('supervision timeout link lost', 'bad')
  setConn('busy', 'link lost reconnecting')
  later(connect, 600)
}

function showLink() {
  const m = modes[mode]
  for (const b of $('modes').children) b.classList.toggle('on', b.dataset.mode === mode)
  $('modeHint').textContent = m.hint
  $('callHint').textContent = m.callHint
  const sel = $('codec')
  sel.textContent = ''
  if (call && mode === 'bt') {
    sel.add(new Option('msbc 16 khz mono'))
    sel.disabled = true
  } else {
    m.codecs.forEach((c, i) => sel.add(new Option(c.name, i)))
    sel.value = codec
    sel.disabled = false
  }
}

function setTarget(ms) {
  $('target').value = ms
  cfg.targetMs = ms
  showVals()
}

function setMode(m) {
  if (m === mode) return
  mode = m
  codec = 0
  runToken++
  showLink()
  setTarget(call && modes[m].call ? modes[m].callTarget : modes[m].targetMs)
  cfg.linkUp = false
  restream()
  if (headsetOn) {
    log('switched to ' + modes[m].label)
    connect()
  } else {
    setConn('off', 'headset off')
  }
}

function setCall(on) {
  call = on
  const m = modes[mode]
  showLink()
  if (m.call) {
    setTarget(on ? m.callTarget : m.targetMs)
    restream()
  }
  if (conn !== 'up') return
  if (mode === 'bt') {
    log(on ? 'avdtp suspend' : 'esco disconnected')
    log(on ? 'hfp audio connect esco msbc' : 'avdtp start')
  } else if (mode === 'le') {
    log(on ? 'ase reconfigured two way lc3 32 khz' : 'ase reconfigured media lc3 48 khz')
  } else {
    log(on ? 'mic slot opened' : 'mic slot closed')
  }
}

function setScene(name) {
  for (const b of $('scenes').children) b.classList.toggle('on', b.dataset.scene === name)
  walkStart = 0
  if (name === 'walk') {
    walkStart = performance.now()
    return
  }
  const s = scenes[name]
  if (!s) return
  if (s.interference !== undefined) $('interference').value = s.interference
  if (s.noise !== undefined) $('noise').value = s.noise
  if (s.distance !== undefined) $('distance').value = s.distance
  if (s.ppm !== undefined) $('ppm').value = s.ppm
  post(s)
  showVals()
}

function walk(now) {
  if (!walkStart) return
  const p = (now - walkStart) / 24000
  if (p >= 1) {
    setScene('')
    $('distance').value = 2
    post({ distance: 2 })
    showVals()
    return
  }
  const d = Math.round((2 + 17 * Math.sin(p * Math.PI)) * 2) / 2
  if (d === cfg.distance) return
  $('distance').value = d
  post({ distance: d })
  showVals()
}

async function makeMusic(sr) {
  const len = 8
  const oc = new OfflineAudioContext(2, sr * len, sr)
  const master = oc.createGain()
  master.gain.value = 0.5
  master.connect(oc.destination)
  const hz = m => 440 * Math.pow(2, (m - 69) / 12)
  const beat = 0.5
  const chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]

  const noise = oc.createBuffer(1, sr, sr)
  const nd = noise.getChannelData(0)
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1

  chords.forEach((ch, ci) => {
    const t0 = ci * 2
    const lp = oc.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 900
    const pg = oc.createGain()
    pg.gain.setValueAtTime(0, t0)
    pg.gain.linearRampToValueAtTime(0.05, t0 + 0.3)
    pg.gain.setValueAtTime(0.05, t0 + 1.75)
    pg.gain.linearRampToValueAtTime(0, t0 + 2)
    lp.connect(pg).connect(master)
    for (const m of ch) {
      for (const det of [-7, 7]) {
        const o = oc.createOscillator()
        o.type = 'sawtooth'
        o.frequency.value = hz(m)
        o.detune.value = det
        o.connect(lp)
        o.start(t0)
        o.stop(t0 + 2)
      }
    }

    for (let b = 0; b < 4; b++) {
      const t = t0 + b * beat
      const o = oc.createOscillator()
      o.type = 'triangle'
      o.frequency.value = hz(ch[0] - 24)
      const g = oc.createGain()
      g.gain.setValueAtTime(0.4, t)
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.45)
      o.connect(g).connect(master)
      o.start(t)
      o.stop(t + 0.5)
    }

    const arp = [ch[0], ch[1], ch[2], ch[0] + 12, ch[2], ch[1] + 12, ch[0] + 12, ch[2] + 12]
    arp.forEach((m, s) => {
      const t = t0 + s * beat / 2
      const o = oc.createOscillator()
      o.type = 'square'
      o.frequency.value = hz(m + 12)
      const f = oc.createBiquadFilter()
      f.type = 'lowpass'
      f.frequency.setValueAtTime(3200, t)
      f.frequency.exponentialRampToValueAtTime(400, t + 0.2)
      const g = oc.createGain()
      g.gain.setValueAtTime(0.07, t)
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.25)
      const pan = oc.createStereoPanner()
      pan.pan.value = s % 2 ? 0.4 : -0.4
      o.connect(f).connect(g).connect(pan).connect(master)
      o.start(t)
      o.stop(t + 0.3)
    })
  })

  for (let b = 0; b < 16; b++) {
    const t = b * beat
    const k = oc.createOscillator()
    k.frequency.setValueAtTime(130, t)
    k.frequency.exponentialRampToValueAtTime(45, t + 0.12)
    const kg = oc.createGain()
    kg.gain.setValueAtTime(0.8, t)
    kg.gain.exponentialRampToValueAtTime(0.001, t + 0.3)
    k.connect(kg).connect(master)
    k.start(t)
    k.stop(t + 0.32)

    const hat = oc.createBufferSource()
    hat.buffer = noise
    const hf = oc.createBiquadFilter()
    hf.type = 'highpass'
    hf.frequency.value = 7000
    const hg = oc.createGain()
    hg.gain.setValueAtTime(0.12, t + beat / 2)
    hg.gain.exponentialRampToValueAtTime(0.001, t + beat / 2 + 0.05)
    hat.connect(hf).connect(hg).connect(master)
    hat.start(t + beat / 2, Math.random() * 0.5, 0.06)

    if (b % 2) {
      const sn = oc.createBufferSource()
      sn.buffer = noise
      const sf = oc.createBiquadFilter()
      sf.type = 'bandpass'
      sf.frequency.value = 1800
      const sg = oc.createGain()
      sg.gain.setValueAtTime(0.5, t)
      sg.gain.exponentialRampToValueAtTime(0.001, t + 0.16)
      sn.connect(sf).connect(sg).connect(master)
      sn.start(t, Math.random() * 0.5, 0.18)
    }
  }

  const buf = await oc.startRendering()
  const l = buf.getChannelData(0)
  const r = buf.getChannelData(1)
  let peak = 0
  for (let i = 0; i < l.length; i++) peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]))
  const k = peak > 0 ? 0.9 / peak : 1
  for (let i = 0; i < l.length; i++) {
    l[i] *= k
    r[i] *= k
  }
  return { l, r }
}

function makeTone(sr) {
  const l = new Float32Array(sr)
  for (let i = 0; i < sr; i++) l[i] = Math.sin(2 * Math.PI * 440 * i / sr) * 0.25
  return { l, r: l.slice() }
}

async function bandLimit(src, cutoff) {
  const sr = ctx.sampleRate
  const n = src.l.length
  const pad = Math.min(n, sr >> 2)
  const oc = new OfflineAudioContext(1, n + pad, sr)
  const buf = oc.createBuffer(1, n + pad, sr)
  const d = buf.getChannelData(0)
  for (let i = 0; i < n + pad; i++) {
    const j = (i + n - pad) % n
    d[i] = (src.l[j] + src.r[j]) * 0.5
  }
  const s = oc.createBufferSource()
  s.buffer = buf
  let tail = s
  for (let i = 0; i < 4; i++) {
    const f = oc.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.value = cutoff
    f.Q.value = i % 2 ? 1.3 : 0.54
    tail.connect(f)
    tail = f
  }
  tail.connect(oc.destination)
  s.start()
  const out = (await oc.startRendering()).getChannelData(0).slice(pad)
  return { l: out, r: out.slice() }
}

async function loadSource(kind, file) {
  if (!ctx) return
  let src
  if (kind === 'file') {
    if (!file) return
    try {
      const buf = await ctx.decodeAudioData(await file.arrayBuffer())
      const max = ctx.sampleRate * 90
      const l = buf.getChannelData(0).slice(0, max)
      const r = buf.numberOfChannels > 1 ? buf.getChannelData(1).slice(0, max) : l.slice()
      src = { l, r }
      log('loaded ' + file.name.toLowerCase() + (buf.length > max ? ' using the first 90 s' : ''))
    } catch {
      log('could not decode that file', 'bad')
      return
    }
  } else {
    if (!srcCache[kind]) srcCache[kind] = kind === 'tone' ? makeTone(ctx.sampleRate) : await makeMusic(ctx.sampleRate)
    src = { l: srcCache[kind].l.slice(), r: srcCache[kind].r.slice() }
  }
  const v = [src, await bandLimit(src, 6800), await bandLimit(src, 14000)]
  node.port.postMessage({ type: 'src', v }, v.flatMap(x => [x.l.buffer, x.r.buffer]))
}

async function init() {
  ctx = new AudioContext({ latencyHint: 'interactive' })
  await ctx.audioWorklet.addModule('link.js')
  node = new AudioWorkletNode(ctx, 'link', { numberOfInputs: 0, outputChannelCount: [2] })
  gain = ctx.createGain()
  gain.gain.value = +$('vol').value
  node.connect(gain).connect(ctx.destination)
  node.port.onmessage = e => onStats(e.data)
  restream()
  await loadSource(srcKind)
}

function onStats(s) {
  if (s.gen < gen) return
  if (s.gen > gen) {
    gen = s.gen
    packets = []
    bufHist = []
    marks = []
    prev = null
    window1 = null
    chRate = null
    chOff = null
  }
  last = s
  lastWall = performance.now()
  if (conn === 'up' && s.lossRunMs > 400) linkLost()

  if (prev) {
    if (s.stats.underruns > prev.stats.underruns) {
      marks.push(s.t)
      if (conn === 'up') log('buffer underrun rebuffering', 'warn')
    }
    if (s.stats.overflows > prev.stats.overflows) {
      marks.push(s.t)
      log('buffer overflow dropped audio', 'warn')
    }
  }
  prev = s

  if (s.chRate) {
    chRate = s.chRate
    chOff = s.chOff
  }
  for (let i = 0; i < s.events.length; i += 4) {
    packets.push({ tries: s.events[i + 1], lost: s.events[i + 2], t: s.events[i + 3] })
  }
  bufHist.push({ t: s.t, v: s.playing ? s.fill * 1000 : 0 })

  while (packets.length && packets[0].t < s.t - 2.5) packets.shift()
  while (bufHist.length && bufHist[0].t < s.t - 11) bufHist.shift()
  while (marks.length && marks[0] < s.t - 11) marks.shift()
}

function updateTiles(now) {
  if (!last || now - tileWall < 120) return
  tileWall = now
  const s = last.stats
  const lat = last.playing ? last.lat * 1000 : 0
  $('lat').textContent = Math.round(lat)
  $('fill').textContent = Math.round(last.fill * 1000)
  $('glitch').textContent = s.concealed + s.underruns + s.overflows
  $('fix').textContent = cfg.asrc && last.playing ? Math.round((last.step - 1) * 1e6) : 0

  const frame = last.playing ? cfg.frameMs : 0
  const radio = last.playing ? Math.min(last.radioMs, Math.max(0, lat - frame)) : 0
  const wait = Math.max(0, lat - frame - radio)
  $('bFrame').style.flexGrow = frame
  $('bRadio').style.flexGrow = radio
  $('bBuf').style.flexGrow = wait
  $('bFrameV').textContent = Math.round(frame) + ' ms'
  $('bRadioV').textContent = Math.round(radio) + ' ms'
  $('bBufV').textContent = Math.round(wait) + ' ms'

  if (chOff) {
    let used = 0
    for (const off of chOff) if (!off) used++
    $('chCount').textContent = 'using ' + used + ' of ' + chOff.length + ' channels'
  }

  if (!window1 || last.t - window1.t >= 1) {
    if (window1) {
      const sent = s.sent - window1.sent
      const dropped = s.dropped - window1.dropped
      const extra = (s.tries - window1.tries) - sent
      $('loss').textContent = sent > 0 ? (dropped / sent * 100).toFixed(1) : '0.0'
      $('retry').textContent = Math.max(0, extra)
    }
    window1 = { t: last.t, sent: s.sent, dropped: s.dropped, tries: s.tries }
  }
}

function fitCanvas(c) {
  const dpr = window.devicePixelRatio || 1
  const w = Math.round(c.clientWidth * dpr)
  const h = Math.round(c.clientHeight * dpr)
  if (c.width !== w || c.height !== h) {
    c.width = w
    c.height = h
  }
  const g = c.getContext('2d')
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.font = '11px system-ui, sans-serif'
  g.textAlign = 'left'
  return { g, w: c.clientWidth, h: c.clientHeight }
}

function placeTip(tip, c, x, y, text) {
  tip.textContent = text
  tip.style.left = c.offsetLeft + Math.max(0, Math.min(x + 10, c.clientWidth - tip.offsetWidth)) + 'px'
  tip.style.top = c.offsetTop + Math.max(0, y - 30) + 'px'
  tip.classList.add('show')
}

function simNow() {
  if (!last) return 0
  const running = ctx && ctx.state === 'running'
  const ahead = running ? Math.min(0.1, (performance.now() - lastWall) / 1000) : 0
  return last.t + ahead
}

const css = getComputedStyle(document.documentElement)
const col = name => css.getPropertyValue(name).trim()
const colors = {
  good: col('--good'), warn: col('--warn'), bad: col('--bad'), hover: col('--hover'),
  grid: col('--grid'), axis: col('--axis'), line: col('--line'), muted: col('--muted'), surface: col('--surface')
}

function drawAir(now) {
  const { g, w, h } = fitCanvas($('air'))
  g.clearRect(0, 0, w, h)
  const base = h - 14
  g.fillStyle = colors.axis
  g.fillRect(0, base, w, 1)
  g.fillStyle = colors.muted
  g.fillText('2 s ago', 0, h - 1)
  g.textAlign = 'right'
  g.fillText('now', w, h - 1)

  const span = 2
  const maxTries = cfg.maxTries || 1
  const bw = Math.max(1, Math.min(6, w / (span * 1000 / cfg.frameMs) - 1))
  for (const p of packets) {
    const x = w - (now - p.t) / span * w
    if (x < -bw || x > w) continue
    const bh = p.lost ? base - 5 : Math.max(4, (base - 5) * p.tries / maxTries)
    g.fillStyle = p.lost ? colors.bad : p.tries > 1 ? colors.warn : colors.good
    g.fillRect(x, base - bh - 1, bw, bh)
  }
}

function drawSpec() {
  const c = $('spec')
  const { g, w, h } = fitCanvas(c)
  g.clearRect(0, 0, w, h)
  const top = 18
  const base = h - 16
  const n = cfg.nCh
  const span = n * cfg.chWidth
  const x = mhz => (mhz - 2401) / span * w
  const cw = w / n

  g.fillStyle = colors.axis
  g.fillRect(0, base, w, 1)
  g.fillStyle = colors.muted
  g.fillText('2402 mhz', 0, h - 2)
  g.textAlign = 'right'
  g.fillText(2401 + span + ' mhz', w, h - 2)
  g.textAlign = 'left'

  if (cfg.interference > 0) {
    const bands = cfg.noise === 'microwave' ? [[2435, 2401 + span, 'microwave']]
      : cfg.noise === 'wifi3' ? [[2401, 2423, 'wifi ch 1'], [2426, 2448, 'wifi ch 6'], [2451, 2473, 'wifi ch 11']]
        : [[2426, 2448, 'wifi ch 6']]
    for (const [a, b, name] of bands) {
      g.fillStyle = colors.warn
      g.fillRect(x(a), 12, x(b) - x(a), 3)
      g.fillStyle = colors.muted
      g.fillText(name, x(a), 9)
    }
  }

  if (!chRate || chRate.length !== n) {
    $('specTip').classList.remove('show')
    return
  }
  for (let i = 0; i < n; i++) {
    const bx = i * cw + 1
    const bwid = Math.max(1, cw - 2)
    if (chOff[i]) {
      g.fillStyle = colors.hover
      g.fillRect(bx, top, bwid, base - top)
    }
    const bh = Math.max(chRate[i] > 0.005 ? 2 : 0, chRate[i] * (base - top))
    g.fillStyle = colors.line
    g.globalAlpha = chOff[i] ? 0.45 : 1
    g.fillRect(bx, base - bh, bwid, bh)
    g.globalAlpha = 1
  }

  if (specHover < 0) {
    $('specTip').classList.remove('show')
    return
  }
  const i = Math.max(0, Math.min(n - 1, Math.floor(specHover / cw)))
  g.fillStyle = colors.muted
  g.fillRect(i * cw, base + 1, cw, 2)
  const text = 2402 + i * cfg.chWidth + ' mhz   ' + Math.round(chRate[i] * 100) + '% failed' + (chOff[i] ? '   avoided' : '')
  placeTip($('specTip'), c, i * cw, top + 30, text)
}

function drawBuf(now) {
  const c = $('buf')
  const { g, w, h } = fitCanvas(c)
  g.clearRect(0, 0, w, h)
  const top = 8
  const base = h - 18
  const span = 10

  let peak = cfg.targetMs * 2
  for (const p of bufHist) if (p.t > now - span && p.v > peak) peak = p.v
  const want = Math.ceil(peak * 1.15 / 10) * 10
  shownMax += (want - shownMax) * 0.08
  const y = v => base - (v / shownMax) * (base - top)

  g.fillStyle = colors.muted
  g.strokeStyle = colors.grid
  g.lineWidth = 1
  for (let i = 1; i <= 3; i++) {
    const v = shownMax * i / 4
    const yy = Math.round(y(v)) + 0.5
    g.beginPath()
    g.moveTo(0, yy)
    g.lineTo(w, yy)
    g.stroke()
    g.fillText(Math.round(v) + ' ms', 2, yy - 3)
  }
  g.fillStyle = colors.axis
  g.fillRect(0, base, w, 1)
  g.fillStyle = colors.muted
  g.fillText('10 s ago', 0, h - 3)
  g.textAlign = 'right'
  g.fillText('now', w, h - 3)
  g.textAlign = 'left'

  const ty = Math.round(y(cfg.targetMs)) + 0.5
  g.strokeStyle = colors.muted
  g.setLineDash([5, 4])
  g.beginPath()
  g.moveTo(0, ty)
  g.lineTo(w, ty)
  g.stroke()
  g.setLineDash([])

  g.fillStyle = colors.bad
  for (const m of marks) {
    const mx = w - (now - m) / span * w
    if (mx >= 0 && mx <= w) g.fillRect(mx - 1, top, 2, base - top)
  }

  g.strokeStyle = colors.line
  g.lineWidth = 2
  g.lineJoin = 'round'
  g.beginPath()
  let started = false
  for (const p of bufHist) {
    const px = w - (now - p.t) / span * w
    if (px < -10) continue
    if (!started) {
      g.moveTo(px, y(p.v))
      started = true
    } else {
      g.lineTo(px, y(p.v))
    }
  }
  g.stroke()

  const tip = $('tip')
  if (bufHover < 0 || !bufHist.length) {
    tip.classList.remove('show')
    return
  }
  const at = now - (w - bufHover) / w * span
  let best = null
  for (const p of bufHist) {
    if (!best || Math.abs(p.t - at) < Math.abs(best.t - at)) best = p
  }
  if (Math.abs(best.t - at) > 0.2) {
    tip.classList.remove('show')
    return
  }
  const bx = w - (now - best.t) / span * w
  g.strokeStyle = colors.muted
  g.lineWidth = 1
  g.beginPath()
  g.moveTo(Math.round(bx) + 0.5, top)
  g.lineTo(Math.round(bx) + 0.5, base)
  g.stroke()
  g.fillStyle = colors.line
  g.beginPath()
  g.arc(bx, y(best.v), 4, 0, Math.PI * 2)
  g.fill()
  g.strokeStyle = colors.surface
  g.lineWidth = 2
  g.stroke()
  placeTip(tip, c, bx, y(best.v), Math.round(best.v) + ' ms   ' + (now - best.t).toFixed(1) + ' s ago')
}

function frame(t) {
  const now = simNow()
  walk(t)
  drawAir(now)
  drawSpec()
  drawBuf(now)
  updateTiles(t)
  requestAnimationFrame(frame)
}

function showVals() {
  $('interferenceVal').textContent = Math.round(cfg.interference * 100) + '%'
  $('distanceVal').textContent = cfg.distance + ' m'
  $('targetVal').textContent = cfg.targetMs + ' ms'
  $('ppmVal').textContent = (cfg.ppm > 0 ? '+' : '') + cfg.ppm + ' ppm'
}

function manual(extra) {
  for (const b of $('scenes').children) b.classList.remove('on')
  walkStart = 0
  post(extra)
  showVals()
}

$('play').onclick = async () => {
  if (!ctx) {
    $('play').disabled = true
    try {
      await init()
    } catch {
      ctx = null
      $('play').disabled = false
      log('audio could not start in this browser', 'bad')
      return
    }
    $('play').disabled = false
  } else if (ctx.state === 'running') {
    await ctx.suspend()
    $('play').textContent = 'play'
    return
  } else {
    await ctx.resume()
  }
  $('play').textContent = 'stop'
  if (!headsetOn) log('audio running turn the headset on to hear it')
}

$('vol').oninput = e => {
  if (gain) gain.gain.setTargetAtTime(+e.target.value, ctx.currentTime, 0.02)
}

$('source').onchange = e => {
  if (e.target.value === 'file') {
    $('file').click()
    return
  }
  srcKind = e.target.value
  loadSource(srcKind)
}

$('file').onchange = e => {
  const f = e.target.files[0]
  e.target.value = ''
  if (!f) return
  if (!ctx) {
    $('source').value = srcKind
    log('press play first then pick the file', 'warn')
    return
  }
  loadSource('file', f)
}

$('file').oncancel = () => {
  $('source').value = srcKind
}

$('modes').onclick = e => {
  const b = e.target.closest('button')
  if (b) setMode(b.dataset.mode)
}

$('scenes').onclick = e => {
  const b = e.target.closest('button')
  if (b) setScene(b.dataset.scene)
}

$('codec').onchange = e => {
  codec = +e.target.value
  restream()
  if (conn === 'up') log('codec changed to ' + modes[mode].codecs[codec].name)
}

$('call').onchange = e => setCall(e.target.checked)
$('power').onclick = power
$('pair').onclick = pair
$('forget').onclick = forget

$('noise').onchange = e => manual({ noise: e.target.value })
$('interference').oninput = e => manual({ interference: +e.target.value })
$('distance').oninput = e => manual({ distance: +e.target.value })
$('ppm').oninput = e => manual({ ppm: +e.target.value })
$('target').oninput = e => { post({ targetMs: +e.target.value }); showVals() }
$('afh').onchange = e => post({ afh: e.target.checked })
$('asrc').onchange = e => post({ asrc: e.target.checked })
$('plc').onchange = e => post({ plc: e.target.checked })
$('bypass').onchange = e => post({ bypass: e.target.checked })

$('buf').onmousemove = e => { bufHover = e.offsetX }
$('buf').onmouseleave = () => { bufHover = -1 }
$('spec').onmousemove = e => { specHover = e.offsetX }
$('spec').onmouseleave = () => { specHover = -1 }

linkStart = performance.now()
Object.assign(cfg, linkCfg())
showLink()
showVals()
setConn('off', 'headset off')
log('press play then power on the headset')
requestAnimationFrame(frame)
