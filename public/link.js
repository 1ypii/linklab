const wifiCenters = { wifi1: [2437], wifi3: [2412, 2437, 2462] }

class Link extends AudioWorkletProcessor {
  constructor() {
    super()
    this.src = null
    this.gen = 0
    this.cfg = {
      frameMs: 20, airMs: 6, retryMs: 3.75, maxTries: 8, inOrder: true,
      nCh: 79, chWidth: 1, sizeScale: 1, variant: 0,
      targetMs: 150, interference: 0, distance: 2, noise: 'wifi1', afh: true, ppm: 0,
      asrc: true, plc: true, bypass: false, linkUp: false
    }
    this.reset()
    this.port.onmessage = e => this.onMsg(e.data)
  }

  onMsg(msg) {
    if (msg.type === 'src') {
      this.src = msg.v
      return
    }
    if (msg.type === 'cfg') {
      const c = msg.cfg
      const changed = (c.frameMs !== undefined && c.frameMs !== this.cfg.frameMs) || (c.nCh !== undefined && c.nCh !== this.cfg.nCh)
      if (c.linkUp && !this.cfg.linkUp) this.lossRun = 0
      if (c.noise !== undefined && c.noise !== this.cfg.noise) this.nets = null
      Object.assign(this.cfg, c)
      if (changed || msg.reset) this.reset()
    }
  }

  reset() {
    const c = this.cfg
    this.gen++
    this.L = Math.max(16, Math.round(c.frameMs * sampleRate / 1000))
    this.cap = Math.ceil(4 * sampleRate / this.L)
    this.ringL = new Float32Array(this.cap * this.L)
    this.ringR = new Float32Array(this.cap * this.L)
    this.seqs = new Int32Array(this.cap).fill(-1)
    this.sendT = new Float64Array(this.cap)
    this.t = 0
    this.txPos = 0
    this.txFrame = 0
    this.pending = []
    this.lastAt = 0
    this.readPos = 0
    this.playing = false
    this.step = 1
    this.integ = 0
    this.fill = 0
    this.fillS = 0
    this.missF = -1
    this.newest = -1
    this.lossRun = 0
    this.radioMs = c.airMs
    this.stats = { sent: 0, tries: 0, dropped: 0, late: 0, concealed: 0, underruns: 0, overflows: 0 }
    this.events = []
    this.nextPost = 0
    this.posts = 0

    this.nets = null
    this.chTry = new Uint16Array(c.nCh)
    this.chFail = new Uint16Array(c.nCh)
    this.chRate = new Float32Array(c.nCh)
    this.chOff = new Uint8Array(c.nCh)
    this.used = Array.from({ length: c.nCh }, (_, i) => i)
    this.nextEval = sampleRate * 0.5
  }

  busy(net, tm) {
    const duty = this.cfg.interference * 0.9
    if (duty <= 0) {
      net.gen = tm
      return false
    }
    while (net.gen <= tm + 1) {
      const on = -Math.log(1 - Math.random()) * 3
      const off = -Math.log(1 - Math.random()) * 3 * (1 - duty) / duty
      net.list.push(net.gen + off, net.gen + off + on)
      net.gen += off + on
    }
    const list = net.list
    for (let i = list.length - 2; i >= 0; i -= 2) {
      if (list[i + 1] < tm) break
      if (list[i] <= tm) return true
    }
    return false
  }

  noise(ch, tm) {
    const c = this.cfg
    const freq = 2402 + ch * c.chWidth
    if (c.noise === 'microwave') {
      return freq >= 2435 && tm % 16.667 < 8.333 ? c.interference : 0
    }
    if (!this.nets) this.nets = wifiCenters[c.noise].map(center => ({ center, list: [], gen: tm }))
    for (const net of this.nets) {
      if (Math.abs(freq - net.center) <= 11 && this.busy(net, tm)) return 0.9
    }
    return 0
  }

  attempt(tm) {
    const c = this.cfg
    const ch = c.afh ? this.used[Math.floor(Math.random() * this.used.length)] : Math.floor(Math.random() * c.nCh)
    const d = Math.max(0, (c.distance - 6) / 14)
    let p = Math.min(0.9, 0.01 + d * d * 0.9) + c.interference * 0.02
    p = Math.max(p, this.noise(ch, tm))
    p = 1 - Math.pow(1 - Math.min(0.98, p), c.sizeScale)
    const fail = Math.random() < p
    this.chTry[ch]++
    if (fail) this.chFail[ch]++
    return !fail
  }

  evalChannels() {
    const c = this.cfg
    const n = c.nCh
    const nowMs = this.t / sampleRate * 1000
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 2; k++) {
        this.chTry[i]++
        if (Math.random() < this.noise(i, nowMs + k * 7)) this.chFail[i]++
      }
      if (this.chTry[i] < 6) continue
      const r = this.chFail[i] / this.chTry[i]
      this.chRate[i] += (r - this.chRate[i]) * (r > this.chRate[i] ? 0.5 : 0.4)
      this.chTry[i] = 0
      this.chFail[i] = 0
    }

    this.used.length = 0
    if (!c.afh) {
      this.chOff.fill(0)
      for (let i = 0; i < n; i++) this.used.push(i)
    } else {
      const sorted = Array.from(this.chRate).sort((x, y) => x - y)
      const limit = Math.max(0.25, sorted[Math.floor(n * 0.1)] * 2.5 + 0.1)
      for (let i = 0; i < n; i++) {
        this.chOff[i] = this.chOff[i] ? this.chRate[i] >= 0.1 : this.chRate[i] > limit
        if (!this.chOff[i]) this.used.push(i)
      }
      const min = Math.min(20, n >> 1)
      while (this.used.length < min) {
        let best = -1
        for (let i = 0; i < n; i++) {
          if (this.chOff[i] && (best < 0 || this.chRate[i] < this.chRate[best])) best = i
        }
        this.chOff[best] = 0
        this.used.push(best)
      }
    }

    if (this.nets) {
      for (const net of this.nets) {
        let cut = 0
        while (cut < net.list.length && net.list[cut + 1] < nowMs - 50) cut += 2
        if (cut) net.list.splice(0, cut)
      }
    }
  }

  send(k) {
    const c = this.cfg
    const nowMs = this.t / sampleRate * 1000
    let tries = 0
    let ok = false
    const flushed = c.inOrder && this.lastAt - this.t > sampleRate * 0.1
    while (!flushed && tries < c.maxTries) {
      ok = this.attempt(nowMs + c.airMs + tries * c.retryMs)
      tries++
      if (ok) break
    }
    this.stats.sent++
    this.stats.tries += tries
    this.sendT[k % this.cap] = this.t
    this.events.push(k, Math.max(1, tries), ok ? 0 : 1, this.t / sampleRate)
    if (!ok) {
      this.stats.dropped++
      this.lossRun++
      return
    }
    this.lossRun = 0
    const ms = c.airMs + (tries - 1) * c.retryMs + Math.random() * 0.4
    let at = this.t + ms * sampleRate / 1000
    if (c.inOrder) {
      at = Math.max(at, this.lastAt)
      this.lastAt = at
    }
    this.radioMs += ((at - this.t) / sampleRate * 1000 - this.radioMs) * 0.05
    let i = this.pending.length
    while (i > 0 && this.pending[i - 1].at > at) i--
    this.pending.splice(i, 0, { k, at })
  }

  deliver(k) {
    const L = this.L
    if (this.playing && (k + 1) * L <= this.readPos) {
      this.stats.late++
      return
    }
    const slot = k % this.cap
    this.seqs[slot] = k
    if (k > this.newest) this.newest = k
    const off = slot * L
    const src = this.src && (this.src[this.cfg.variant] || this.src[0])
    if (!src) {
      this.ringL.fill(0, off, off + L)
      this.ringR.fill(0, off, off + L)
      return
    }
    const n = src.l.length
    let s = (k * L) % n
    for (let j = 0; j < L; j++) {
      this.ringL[off + j] = src.l[s]
      this.ringR[off + j] = src.r[s]
      if (++s === n) s = 0
    }
  }

  has(f) {
    return f >= 0 && this.seqs[f % this.cap] === f
  }

  contigEnd(from) {
    let f = Math.floor(from / this.L)
    const lim = f + this.cap - 1
    while (f < lim && this.has(f)) f++
    return f * this.L
  }

  sample(i, ring) {
    const f = Math.floor(i / this.L)
    if (!this.has(f)) return null
    return ring[(f % this.cap) * this.L + (i - f * this.L)]
  }

  rebuffer() {
    const L = this.L
    const sr = sampleRate
    let f = Math.max(Math.floor(this.readPos / L), this.txFrame - this.cap + 1)
    if (!this.has(f)) {
      const lim = Math.min(this.txFrame, f + this.cap)
      while (f < lim && !this.has(f)) f++
      if (f >= lim) return
      this.readPos = f * L
    }
    const target = this.cfg.targetMs * sr / 1000
    const end = this.contigEnd(this.readPos)
    if (end - this.readPos < target) return
    if (end - this.readPos > target + L) this.readPos = Math.floor((end - target) / L) * L
    this.playing = true
    this.integ = 0
    this.fillS = this.cfg.targetMs / 1000
  }

  process(inputs, outputs) {
    const out = outputs[0]
    const outL = out[0]
    const outR = out[1] || out[0]
    const c = this.cfg
    const sr = sampleRate
    const L = this.L
    const rate = 1 + c.ppm / 1e6
    const n = outL.length
    const ramp = Math.min(L / 4, sr * 0.0015)

    if (this.t >= this.nextEval) {
      this.nextEval = this.t + sr * 0.5
      this.evalChannels()
    }

    if (!this.playing) this.rebuffer()

    if (this.playing) {
      const ahead = (this.newest + 1) * L - this.readPos
      this.fill = Math.max(0, ahead) / sr
      const maxBuf = c.targetMs * 3 / 1000 + 0.02
      if (ahead / sr > maxBuf) {
        this.stats.overflows++
        this.readPos = (this.newest + 1) * L - c.targetMs * sr / 1000
        this.fillS = c.targetMs / 1000
      }
      if (c.asrc) {
        const dt = n / sr
        this.fillS += (this.fill - this.fillS) * (1 - Math.exp(-dt / 0.25))
        const e = this.fillS - c.targetMs / 1000
        this.integ = Math.max(-0.1, Math.min(0.1, this.integ + e * dt))
        const corr = 0.6 * e + 0.25 * this.integ
        this.step = 1 + Math.max(-0.02, Math.min(0.02, corr))
      } else {
        this.step = 1
        this.integ = 0
        this.fillS = this.fill
      }
    } else {
      this.fill = 0
    }

    const dry = this.src && this.src[0]

    for (let j = 0; j < n; j++) {
      this.txPos += rate
      while (this.txPos >= (this.txFrame + 1) * L) {
        if (c.linkUp) this.send(this.txFrame)
        this.txFrame++
      }
      while (this.pending.length && this.pending[0].at <= this.t) this.deliver(this.pending.shift().k)

      if (c.bypass) {
        if (dry) {
          const i = Math.floor(this.txPos) % dry.l.length
          outL[j] = dry.l[i]
          outR[j] = dry.r[i]
        } else {
          outL[j] = 0
          outR[j] = 0
        }
        if (this.playing) this.readPos += this.step
        this.t++
        continue
      }

      if (!this.playing) {
        outL[j] = 0
        outR[j] = 0
        this.t++
        continue
      }

      const i0 = Math.floor(this.readPos)
      const f = Math.floor(i0 / L)
      const got = this.has(f)
      if (!got && f > this.newest) {
        this.playing = false
        this.stats.underruns++
        outL[j] = 0
        outR[j] = 0
        this.t++
        continue
      }

      if (got) {
        const fr = this.readPos - i0
        const a = this.sample(i0, this.ringL)
        const b = this.sample(i0 + 1, this.ringL)
        const ar = this.sample(i0, this.ringR)
        const br = this.sample(i0 + 1, this.ringR)
        outL[j] = b === null ? a : a + (b - a) * fr
        outR[j] = br === null ? ar : ar + (br - ar) * fr
      } else {
        if (f !== this.missF) {
          this.missF = f
          this.stats.concealed++
        }
        let l = 0
        let r = 0
        if (c.plc) {
          const inF = i0 - f * L
          const edge = Math.min(inF, L - 1 - inF)
          const w = Math.min(1, edge / ramp)
          for (let m = 1; m <= 4; m++) {
            const p = i0 - m * L
            const v = this.sample(p, this.ringL)
            if (v === null) continue
            const g = Math.pow(0.7, m) * w
            l = v * g
            r = this.sample(p, this.ringR) * g
            break
          }
        }
        outL[j] = l
        outR[j] = r
      }
      this.readPos += this.step
      this.t++
    }

    if (this.t >= this.nextPost) {
      this.nextPost = this.t + sr * 0.05
      let lat = 0
      if (this.playing) {
        const f = Math.floor(this.readPos / L)
        if (this.has(f)) lat = (this.t - this.sendT[f % this.cap] + ((f + 1) * L - this.readPos)) / sr
        else lat = c.targetMs / 1000
      }
      const msg = {
        gen: this.gen,
        t: this.t / sr,
        fill: this.fill,
        lat,
        radioMs: this.radioMs,
        step: this.step,
        playing: this.playing,
        lossRunMs: this.lossRun * c.frameMs,
        stats: this.stats,
        events: this.events
      }
      if (this.posts++ % 5 === 0) {
        msg.chRate = this.chRate.slice()
        msg.chOff = this.chOff.slice()
      }
      this.port.postMessage(msg)
      this.events = []
    }
    return true
  }
}

registerProcessor('link', Link)
