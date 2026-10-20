/* Mic capture -> raw PCM -> 16 kHz mono WAV, plus simple quality checks.
   Browser processing (echo cancellation, noise suppression, AGC) is switched off
   so the stored audio is as close to the microphone signal as the device allows. */
const Recorder = (() => {
  const TARGET_SR = 16000;
  const WORKLET = `class Tap extends AudioWorkletProcessor {
    process(inputs) { const ch = inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
  } registerProcessor('tap', Tap);`;

  let ctx, stream, src, analyser, node, chunks = null, levelBuf;

  async function open() {
    if (ctx) return;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    ctx = new AudioContext();
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })));
    src = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    levelBuf = new Float32Array(analyser.fftSize);
    node = new AudioWorkletNode(ctx, "tap");
    node.port.onmessage = (e) => { if (chunks) chunks.push(e.data); };
    src.connect(analyser);
    src.connect(node);
    // the worklet needs a path to the destination to keep running; route it through a muted gain
    const mute = ctx.createGain(); mute.gain.value = 0;
    node.connect(mute).connect(ctx.destination);
  }

  function close() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (ctx) ctx.close();
    ctx = stream = null;
  }

  /** current RMS level 0..1 (for meters) and the time-domain buffer (for waveforms) */
  function level() {
    if (!analyser) return { rms: 0, buf: null };
    analyser.getFloatTimeDomainData(levelBuf);
    let s = 0; for (const v of levelBuf) s += v * v;
    return { rms: Math.sqrt(s / levelBuf.length), buf: levelBuf };
  }

  function start() { if (ctx.state === "suspended") ctx.resume(); chunks = []; }

  async function stop() {
    const parts = chunks || []; chunks = null;
    const n = parts.reduce((a, c) => a + c.length, 0);
    const raw = new Float32Array(n);
    let o = 0; for (const c of parts) { raw.set(c, o); o += c.length; }
    const pcm = await resample(raw, ctx.sampleRate, TARGET_SR);
    return { pcm, sr: TARGET_SR, deviceSr: ctx.sampleRate };
  }

  async function resample(x, from, to) {
    if (!x.length) return x;
    if (from === to) return x;
    const len = Math.max(1, Math.round((x.length * to) / from));
    const off = new OfflineAudioContext(1, len, to);
    const b = off.createBuffer(1, x.length, from);
    b.copyToChannel(x, 0);
    const s = off.createBufferSource(); s.buffer = b; s.connect(off.destination); s.start();
    return (await off.startRendering()).getChannelData(0);
  }

  function wav(pcm, sr) {
    const buf = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sr, true);
    v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data");
    v.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
    return new Blob([buf], { type: "audio/wav" });
  }

  const db = (r) => 20 * Math.log10(Math.max(r, 1e-9));

  /** frame-level stats: overall speech level (loudest 30% of 20 ms frames), noise (quietest 20%), clipping */
  function stats(pcm, sr) {
    const f = Math.round(sr * 0.02), rms = [];
    let clip = 0;
    for (let i = 0; i + f <= pcm.length; i += f) {
      let s = 0;
      for (let j = i; j < i + f; j++) { s += pcm[j] * pcm[j]; if (Math.abs(pcm[j]) > 0.985) clip++; }
      rms.push(Math.sqrt(s / f));
    }
    rms.sort((a, b) => a - b);
    const pick = (lo, hi) => { const a = rms.slice(Math.floor(lo * rms.length), Math.ceil(hi * rms.length)); return a.reduce((x, y) => x + y, 0) / Math.max(1, a.length); };
    return { dur: pcm.length / sr, speechDb: db(pick(0.7, 1)), noiseDb: db(pick(0, 0.2)), clipFrac: clip / Math.max(1, pcm.length) };
  }

  /** verdict for one take: {ok, level: 'ok'|'meh'|'bad', msg} */
  function judge(st, { minDur = 1, noiseFloorDb = null } = {}) {
    if (st.dur < minDur) return { ok: false, level: "bad", msg: "Too short — please try again" };
    if (st.speechDb < -48) return { ok: false, level: "bad", msg: "We can barely hear you — move closer" };
    if (st.clipFrac > 0.002) return { ok: true, level: "meh", msg: "A bit loud (some clipping) — usable, or step back a little" };
    const noise = noiseFloorDb ?? st.noiseDb;
    const snr = st.speechDb - noise;
    if (snr < 12) return { ok: true, level: "meh", msg: `Noisy around you (≈${Math.round(snr)} dB above background)` };
    return { ok: true, level: "ok", msg: `Clear ✓ (≈${Math.round(snr)} dB above background)` };
  }

  return { open, close, level, start, stop, wav, stats, judge, db, TARGET_SR };
})();
