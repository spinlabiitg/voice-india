/* Lend Your Voice. Map of district lights + record and listen flows.
   With SUPABASE_URL set in config.js, clips upload to Supabase (see submitContribution);
   without it the page is a mock-up and nothing leaves the browser. ?demo shows made-up counts. */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const store = {
  get(k, d) { try { const v = localStorage.getItem("lyv-" + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("lyv-" + k, JSON.stringify(v)); } catch {} },
};
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const GOAL = 50; // voices per district to call it "bright"
const IFACE_PROMPT_KEY = { Hindi: "hi" };

let map, lights, places, prompts, listenClips, hoverId = null;
const S = { district: store.get("district", null), language: store.get("language", ""),
  clips: [], noiseDb: null, details: {}, step: null };

/* ===================== backend (Supabase) ===================== */
const CFG = window.LYV_CONFIG || {};
const CONTACT = CFG.CONTACT_EMAIL || "neerajs@iitg.ac.in"; // questions from contributors
const LIVE = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && window.supabase);
const DEMO = new URLSearchParams(location.search).has("demo") || !LIVE; // made-up counts unless connected
const sb = LIVE ? supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY,
  { auth: { persistSession: true, autoRefreshToken: true, storageKey: "lyv-auth" } }) : null;

/** anonymous session (no login screen); reused across contributions on this device.
    A new session needs a Cloudflare Turnstile token when TURNSTILE_SITE_KEY is set
    (Supabase checks it: Authentication -> Attack Protection -> CAPTCHA). */
async function ensureSession() {
  const { data } = await sb.auth.getSession();
  if (data.session) return data.session.user.id;
  const captchaToken = await turnstileToken();
  const { data: d, error } = await sb.auth.signInAnonymously(captchaToken ? { options: { captchaToken } } : undefined);
  if (error) throw error;
  return d.user.id;
}
let turnstileLoad = null;
function loadTurnstile() {
  return (turnstileLoad ||= new Promise((ok, fail) => {
    const sc = document.createElement("script");
    sc.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"; sc.async = true;
    sc.onload = () => ok(window.turnstile);
    sc.onerror = () => { turnstileLoad = null; fail(new Error("couldn't load the bot check")); };
    document.head.appendChild(sc);
  }));
}
/** runs the check in #ts-box; it stays invisible unless Cloudflare wants the person to tick a box */
async function turnstileToken() {
  if (!CFG.TURNSTILE_SITE_KEY) return null;
  const ts = await loadTurnstile();
  let box = $("#ts-box");
  if (!box) { box = document.createElement("div"); box.id = "ts-box"; document.body.appendChild(box); }
  box.innerHTML = "";
  return new Promise((ok, fail) => {
    const id = ts.render(box, {
      sitekey: CFG.TURNSTILE_SITE_KEY, appearance: "interaction-only", action: "anon-signin",
      callback: (t) => { ok(t); setTimeout(() => ts.remove(id), 0); },
      "error-callback": () => { fail(new Error("the bot check failed")); setTimeout(() => ts.remove(id), 0); },
      "timeout-callback": () => fail(new Error("the bot check timed out")),
    });
  });
}
async function retry(fn, tries = 3) {
  for (let k = 1; ; k++) { try { return await fn(); } catch (e) { if (k >= tries) throw e; await sleep(1000 * k); } }
}
function newCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", r = crypto.getRandomValues(new Uint8Array(8));
  const s = Array.from(r, (x) => A[x % A.length]).join("");
  return `LYV-${s.slice(0, 4)}-${s.slice(4)}`;
}
async function loadCounts() {
  if (DEMO) return;
  lights.features.forEach((f) => (f.properties.n = 0));
  try {
    const { data, error } = await sb.rpc("district_counts");
    if (error) throw error;
    const by = Object.fromEntries(data.map((r) => [r.district_id, Number(r.n)]));
    lights.features.forEach((f) => (f.properties.n = by[f.properties.id] || 0));
  } catch (e) { console.warn("Couldn't load district counts", e); }
}

/* ===================== data + map ===================== */
async function boot() {
  [lights, places, prompts, listenClips] = await Promise.all(
    ["lights.geojson", "places.json", "prompts.json", "listen.json"].map((f) => fetch("data/" + f).then((r) => r.json())));
  await loadCounts();
  $(".demo-pill").innerHTML = LIVE ? (DEMO ? "Pilot · showing demo counts" : "Pilot") : 'Mock-up<span class="long"> · demo counts · nothing leaves your device</span>';
  if (!DEMO) $("#demo-note")?.remove();
  renderStats();
  map = new maplibregl.Map({
    container: "map",
    style: { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#ffffff" } }] },
    bounds: [[67.5, 6.5], [97.8, 37.3]], fitBoundsOptions: { padding: fitPad() },
    attributionControl: false, dragRotate: false, pitchWithRotate: false, maxZoom: 9, minZoom: 3,
  });
  map.touchZoomRotate.disableRotation();
  map.on("load", () => {
    map.addSource("districts", { type: "geojson", data: "data/districts.geojson", promoteId: "id" });
    map.addSource("states", { type: "geojson", data: "data/states.geojson" });
    map.addSource("lights", { type: "geojson", data: lights, promoteId: "id" });
    map.addSource("me", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "d-fill", type: "fill", source: "districts", paint: {
      "fill-color": ["case", ["boolean", ["feature-state", "sel"], false], "#ffc35c", "#dfe3ef"],
      "fill-opacity": ["case", ["boolean", ["feature-state", "sel"], false], 0.45,
        ["boolean", ["feature-state", "hover"], false], 0.9, 0.45] } });
    map.addLayer({ id: "d-line", type: "line", source: "districts", paint: { "line-color": "#ffffff", "line-opacity": 0.9, "line-width": 0.6 } });
    map.addLayer({ id: "s-line", type: "line", source: "states", paint: { "line-color": "#9aa3c2", "line-opacity": 0.9, "line-width": 0.9 } });
    const r = (k) => ["interpolate", ["linear"], ["zoom"], 3.5, ["*", k, 1], 6, ["*", k, 2.2], 9, ["*", k, 4]];
    const size = ["case", [">", ["get", "n"], 0], ["+", 1.1, ["*", 0.42, ["sqrt", ["get", "n"]]]], 0.9];
    map.addLayer({ id: "glow", type: "circle", source: "lights", filter: [">", ["get", "n"], 0], paint: {
      "circle-radius": r(["*", 2.6, size]), "circle-color": "#f59e2b", "circle-blur": 1, "circle-opacity": 0.3 } });
    map.addLayer({ id: "core", type: "circle", source: "lights", paint: {
      "circle-radius": r(size),
      "circle-color": ["case", [">", ["get", "n"], 0], ["interpolate", ["linear"], ["get", "n"], 1, "#f7b54a", GOAL, "#c4520a"], "#ffffff"],
      "circle-stroke-color": ["case", [">", ["get", "n"], 0], "#ffffff", "#a7afca"], "circle-stroke-width": ["case", [">", ["get", "n"], 0], 0.6, 0.9],
      "circle-opacity": 0.9 } });
    map.addLayer({ id: "me-ring", type: "circle", source: "me", paint: { "circle-radius": 0, "circle-color": "#f59e2b",
      "circle-opacity": 0, "circle-stroke-color": "#e07a12", "circle-stroke-width": 2, "circle-stroke-opacity": 0 } });

    map.on("mousemove", "d-fill", (e) => {
      const f = e.features[0];
      if (!f.properties.selectable) return;
      if (hoverId !== f.id) { setHover(null); hoverId = f.id; map.setFeatureState({ source: "districts", id: f.id }, { hover: true }); }
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", "d-fill", () => { setHover(null); map.getCanvas().style.cursor = ""; });
    map.on("click", "d-fill", (e) => { const p = e.features[0].properties; if (p.selectable) openDistrict(p.id); });
    if (!REDUCED) twinkle();
  });
}
const fitPad = () => (innerWidth < 720 ? { top: 70, bottom: 300, left: 10, right: 10 } : { top: 60, bottom: 40, left: 470, right: 40 });
function setHover(id) { if (hoverId) map.setFeatureState({ source: "districts", id: hoverId }, { hover: false }); hoverId = id; }

function twinkle() {
  const t0 = performance.now();
  setInterval(() => {
    const t = (performance.now() - t0) / 900;
    map.setPaintProperty("core", "circle-opacity", ["case", [">", ["get", "n"], 0],
      ["+", 0.85, ["*", 0.15, ["sin", ["+", t, ["get", "ph"]]]]], 0.9]);
    map.setPaintProperty("glow", "circle-opacity", ["+", 0.22, ["*", 0.1, ["sin", ["+", t * 0.7, ["get", "ph"]]]]]);
  }, 120);
}

function totals() {
  const fs = lights.features;
  return { voices: fs.reduce((a, f) => a + f.properties.n, 0), lit: fs.filter((f) => f.properties.n > 0).length, all: fs.length };
}
function renderStats() {
  const t = totals();
  $("#stats").innerHTML = `<span class="stat"><b>${t.voices.toLocaleString("en-IN")}</b> voice${t.voices === 1 ? "" : "s"}</span>
    <span class="stat"><b>${t.lit}</b> of ${t.all} districts lit</span>
    <span class="stat"><b>${Object.keys(places.states).length}</b> states &amp; UTs</span>`;
}
const lightOf = (id) => lights.features.find((f) => f.properties.id === id);

let selId = null;
function select(id) {
  if (!map?.getLayer("d-fill")) { map?.once("load", () => select(id)); return; } // map still loading
  if (selId) map.setFeatureState({ source: "districts", id: selId }, { sel: false });
  selId = id;
  if (id) map.setFeatureState({ source: "districts", id }, { sel: true });
}

function openDistrict(id) {
  const f = lightOf(id); if (!f) return;
  const { name, state, n } = f.properties;
  select(id);
  $("#hero").classList.add("away");
  const langs = places.states[state]?.languages.slice(0, 6) || [];
  const left = Math.max(0, GOAL - n);
  const el = $("#dcard");
  el.innerHTML = `<button class="icon-btn x" aria-label="Close">✕</button>
    <h2>${esc(name)}</h2><div class="state">${esc(state)}</div>
    <div class="goal"><div class="goal-bar"><i style="width:${Math.min(100, (n / GOAL) * 100)}%"></i></div>
      <div class="goal-txt">${n ? `<b>${n}</b> voice${n > 1 ? "s" : ""} so far` : "No voices yet — be the first!"}
      ${left ? ` · ${left} more to light it up fully` : " · fully lit ✨"}</div></div>
    <div class="note">Languages spoken in ${esc(state)} (Census 2011)</div>
    <div class="chips">${langs.map((l) => `<span class="chip">${esc(l)}</span>`).join("")}</div>
    <button class="btn primary block"><span class="mic-ico"></span>Add a voice from ${esc(name)}</button>`;
  el.hidden = false;
  $(".x", el).onclick = closeDistrict;
  $(".btn.primary", el).onclick = () => { S.district = { id, name, state }; store.set("district", S.district); el.hidden = true; startRecord(); };
  map.easeTo({ center: f.geometry.coordinates, zoom: Math.max(map.getZoom(), 5.2), padding: innerWidth < 720 ? { bottom: 260 } : { right: 340 }, duration: 800 });
}
function closeDistrict() { $("#dcard").hidden = true; select(null); $("#hero").classList.remove("away"); }

/* ===================== drawer ===================== */
const body = () => $("#body");
function openDrawer(steps, cur) {
  stopLoops();
  $("#hero").classList.add("away"); $("#dcard").hidden = true;
  $("#drawer").hidden = false;
  $("#steps").innerHTML = steps ? Array.from({ length: steps }, (_, i) => `<i class="${i <= cur ? "on" : ""}"></i>`).join("") : "";
}
function closeDrawer() {
  $("#drawer").hidden = true; stopLoops(); Recorder.close();
  $("#hero").classList.remove("away"); select(null);
}
$("#close").onclick = closeDrawer;
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#drawer").hidden) closeDrawer(); });
document.querySelectorAll("[data-go]").forEach((b) => b.onclick = () => ({ record: startRecord, listen: startListen })[b.dataset.go]());
$("#credits-btn").onclick = () => $("#credits").showModal();

function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("on"), 2600); }
let loops = [];
function loop(fn) { let on = true; const f = () => { if (!on) return; fn(); requestAnimationFrame(f); }; f(); const h = () => (on = false); loops.push(h); return h; }
function stopLoops() { loops.forEach((h) => h()); loops = []; }

/* ===================== record flow ===================== */
const REC_STEPS = 5; // where, consent, mic, record, details
function startRecord() { S.clips = []; S.noiseDb = null; S.code = null; stepWhere(); }

function stepWhere() {
  openDrawer(REC_STEPS, 0);
  const st = S.district?.state || "";
  body().innerHTML = `<h2 id="drawer-title">Where are you from?</h2>
    <p class="lede">Choose the district whose speech you grew up with, and the language you'll speak in.</p>
    <div class="field"><label for="f-state">State / UT</label><select id="f-state"><option value="">Choose…</option>
      ${Object.keys(places.states).map((s) => `<option ${s === st ? "selected" : ""}>${esc(s)}</option>`).join("")}</select></div>
    <div class="field"><label for="f-dist">District</label><select id="f-dist"></select></div>
    <div class="field"><span class="lbl">Language you'll speak in</span><div class="seg" id="f-lang"></div>
      <input type="text" id="f-lang-other" placeholder="Type your language" style="margin-top:8px" hidden></div>
    <div class="nav"><button class="btn primary" id="next" disabled>Next</button></div>`;
  const fs = $("#f-state"), fd = $("#f-dist"), fl = $("#f-lang"), fo = $("#f-lang-other"), next = $("#next");
  const fillDist = () => {
    const ds = places.states[fs.value]?.districts || [];
    fd.innerHTML = `<option value="">Choose…</option>` + ds.map((d) => `<option value="${d.id}" ${d.id === S.district?.id ? "selected" : ""}>${esc(d.name)}</option>`).join("");
    const langs = [...(places.states[fs.value]?.languages.slice(0, 9) || [])];
    if (!langs.includes("English")) langs.push("English");
    fl.innerHTML = langs.map((l) => `<button type="button" class="${l === S.language ? "on" : ""}">${esc(l)}</button>`).join("") + `<button type="button" data-other>Other…</button>`;
    if (S.language && !langs.includes(S.language)) { fl.lastChild.classList.add("on"); fo.hidden = false; fo.value = S.language; }
    validate();
  };
  const validate = () => { next.disabled = !(fd.value && S.language); };
  fs.onchange = () => { S.district = null; fillDist(); };
  fd.onchange = () => { const d = places.states[fs.value].districts.find((x) => x.id === fd.value); S.district = d ? { ...d, state: fs.value } : null; if (d) { select(d.id); flyTo(d.id); } validate(); };
  fl.onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    fl.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    fo.hidden = !b.dataset.other; S.language = b.dataset.other ? fo.value.trim() : b.textContent;
    if (b.dataset.other) fo.focus(); validate();
  };
  fo.oninput = () => { S.language = fo.value.trim(); validate(); };
  next.onclick = () => { store.set("district", S.district); store.set("language", S.language); stepConsent(); };
  if (st) fillDist();
  if (S.district) { select(S.district.id); flyTo(S.district.id); }
}
function flyTo(id) { const f = lightOf(id); if (f && map) map.easeTo({ center: f.geometry.coordinates, zoom: 5.4, padding: innerWidth < 720 ? {} : { right: 460 }, duration: 700 }); }

function stepConsent() {
  openDrawer(REC_STEPS, 1);
  body().innerHTML = `<h2 id="drawer-title">Before you record</h2>
    <ul class="points">
      <li>You'll see <b>2 pictures</b>. For each, record the word for it in your language and then 1–3 sentences using that word: 4 short clips in all.</li>
      <li>We keep your <b>voice, district, language</b> and the few details you choose to give. No name, phone number or exact location.</li>
      <li>Recordings will be shared openly for research and for building speech technology in Indian languages.
        Once you submit, they <b>can't be withdrawn</b>: copies of an open dataset can't be recalled.</li>
      <li>Please don't say names, phone numbers or other private details in your answers.</li>
    </ul>
    <label class="check"><input type="checkbox" id="c-age"> I am 18 or older.</label>
    <label class="check"><input type="checkbox" id="c-ok"> I agree to my recordings being shared under the CC BY 4.0 licence.</label>
    <p class="note">Draft wording — the final text will follow IITG ethics committee approval and be shown in your language.</p>
    <div class="nav"><button class="btn" id="back">Back</button><button class="btn primary" id="next" disabled>I agree</button></div>`;
  const upd = () => { $("#next").disabled = !($("#c-age").checked && $("#c-ok").checked); };
  $("#c-age").onchange = $("#c-ok").onchange = upd;
  $("#back").onclick = stepWhere; $("#next").onclick = stepMic;
}

function stepMic() {
  openDrawer(REC_STEPS, 2);
  body().innerHTML = `<h2 id="drawer-title">Quick sound check</h2>
    <p class="lede">Find a quiet spot and hold your phone about a hand's length away.</p>
    <div class="meter"><i id="lvl"></i></div>
    <p id="mic-msg" class="note">Tap start, stay quiet for 2 seconds, then say “hello, testing”.</p>
    <div class="nav"><button class="btn" id="back">Back</button><button class="btn primary" id="go">Start sound check</button></div>`;
  $("#back").onclick = () => { stopLoops(); stepConsent(); };
  $("#go").onclick = async () => {
    const go = $("#go"), msg = $("#mic-msg");
    try { await Recorder.open(); } catch (e) { msg.innerHTML = `<span class="q-bad">Couldn't use the microphone (${esc(e.message || e.name)}). Please allow mic access and try again.</span>`; return; }
    loop(() => { $("#lvl") && ($("#lvl").style.width = Math.min(100, Recorder.level().rms * 400) + "%"); });
    go.disabled = true;
    msg.textContent = "Stay quiet…"; Recorder.start();
    await sleep(2000); const quiet = Recorder.stats((await Recorder.stop()).pcm, Recorder.TARGET_SR);
    msg.textContent = "Now say “hello, testing”…"; Recorder.start();
    await sleep(2500); const talk = Recorder.stats((await Recorder.stop()).pcm, Recorder.TARGET_SR);
    S.noiseDb = quiet.speechDb; // loudness of the "quiet" period = room noise
    const snr = talk.speechDb - S.noiseDb;
    const ok = talk.speechDb > -48 && snr > 10;
    msg.innerHTML = ok ? `<span class="q-ok">Sounds good ✓</span> Your voice is ≈${Math.round(snr)} dB above the background.`
      : talk.speechDb <= -48 ? `<span class="q-bad">We could hardly hear you.</span> Move closer and try again.`
      : `<span class="q-meh">It's a bit noisy there (≈${Math.round(snr)} dB).</span> A quieter spot helps, but you can carry on.`;
    go.disabled = false; go.textContent = "Continue"; go.onclick = () => { stopLoops(); stepRecord(0); };
    const again = document.createElement("button"); again.className = "btn"; again.textContent = "Retry"; again.onclick = stepMic;
    $("#back").replaceWith(again);
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Two objects. For each: (a) "What do you call this?" -> one word, then
   (b) "Say a sentence using that word" -> one sentence. 4 clips in all:
   S.clips[2k] = word, S.clips[2k + 1] = sentence for object k. */
let TASKS = [{ label: "Word 1" }, { label: "Sentences 1" }, { label: "Word 2" }, { label: "Sentences 2" }];
const LIMITS = { word: { min: 0.3, max: 5 }, sentence: { min: 1.5, max: 30 } };
let objects = null, activeBtn = null;

function pickObjects() {
  const sh = prompts.pictures.map((x) => [Math.random(), x]).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
  return sh.slice(0, 2).concat(sh.slice(2)); // first two used, rest are spares for "different picture"
}

function stepRecord(k) {
  if (k === 0 && !S.clips.length) objects = pickObjects();
  openDrawer(REC_STEPS, 3);
  const obj = objects[k], w = (S.clips[2 * k] ||= { kind: "word", picture: obj.id }), s = (S.clips[2 * k + 1] ||= { kind: "sentence", picture: obj.id });
  // questions are always in English (decided 2026-10-18: no translated UI text)
  const ask = (key) => `<div class="say q">${esc(prompts.questions[key].replace("{obj}", obj.en_q).replace("{lang}", S.language))}</div>`;
  body().innerHTML = `<h2 id="drawer-title" class="sr">Object ${k + 1} of 2</h2>
    <div class="rail">${TASKS.map((t, j) => `<div class="${Math.floor(j / 2) === k ? "cur" : ""} ${S.clips[j]?.q?.ok ? "ok" : ""}">${t.label}</div>`).join("")}</div>
    <div class="card obj">
      <div class="kind">Object ${k + 1} of 2 · answer in ${esc(S.language)}</div>
      <img class="pic" src="${obj.file}" alt="Picture of ${esc(obj.en_q)}" width="150" height="150">
      <div class="pic-name">${esc(obj.en)}</div>
      <button class="btn small swap" id="skip">↻ Different picture</button>
    </div>
    <section class="qa" id="qa-word"><div class="qa-n">1</div><div class="qa-main">${ask("word")}
      <div class="qa-rec"><button class="recbtn sm" aria-label="Record the word"></button><span class="timer">Tap to record · one word</span></div>
      <div class="take-slot"></div></div></section>
    <section class="qa" id="qa-sent"><div class="qa-n">2</div><div class="qa-main">${ask("sentence")}
      <div class="qa-rec"><button class="recbtn sm" aria-label="Record the sentences"></button><span class="timer">Tap to record · 1–3 sentences</span></div>
      <div class="take-slot"></div></div></section>
    <div class="nav"><button class="btn" id="back">Back</button><button class="btn primary" id="next">${k === 0 ? "Next object" : "Almost done"}</button></div>`;

  const wordBox = $("#qa-word"), sentBox = $("#qa-sent"), next = $("#next");
  const refresh = () => {
    sentBox.classList.toggle("locked", !w.q?.ok);
    $(".recbtn", sentBox).disabled = !w.q?.ok;
    next.disabled = !(w.q?.ok && s.q?.ok);
  };
  wireRecorder(wordBox, w, LIMITS.word, refresh);
  wireRecorder(sentBox, s, LIMITS.sentence, refresh);
  refresh();
  loop(() => { if (activeBtn) activeBtn.style.setProperty("--lvl", Math.min(1, Recorder.level().rms * 6).toFixed(2)); });

  $("#skip").onclick = () => {
    if (S.clips[2 * k]?.blob || S.clips[2 * k + 1]?.blob) { if (!confirm("Switch picture? Your recordings for this one will be removed.")) return; }
    [w, s].forEach((c) => c.url && URL.revokeObjectURL(c.url));
    S.clips[2 * k] = S.clips[2 * k + 1] = undefined;
    const used = new Set(objects.slice(0, 2).map((o) => o.id));
    const spare = objects.slice(2).find((o) => !used.has(o.id));
    objects.splice(objects.indexOf(spare), 1); objects.push(objects[k]); objects[k] = spare;
    stepRecord(k);
  };
  $("#back").onclick = () => (k ? stepRecord(0) : stepMic());
  next.onclick = () => (k === 0 ? stepRecord(1) : stepDetails());
}

function wireRecorder(box, c, lim, onChange) {
  const btn = $(".recbtn", box), timer = $(".timer", box), slot = $(".take-slot", box);
  let recording = false, t0 = 0, tick;
  if (c.blob) showTake(c, slot);
  btn.onclick = async () => {
    if (!recording) {
      if (activeBtn) return; // one recording at a time
      recording = true; activeBtn = btn; t0 = performance.now(); btn.classList.add("on"); btn.setAttribute("aria-label", "Stop recording");
      slot.innerHTML = ""; Recorder.start();
      tick = setInterval(() => { const t = (performance.now() - t0) / 1000; timer.textContent = `${t.toFixed(1)} s · tap to stop`; if (t >= lim.max) btn.click(); }, 100);
    } else {
      recording = false; activeBtn = null; clearInterval(tick); btn.classList.remove("on"); btn.style.removeProperty("--lvl");
      btn.setAttribute("aria-label", "Record again"); timer.textContent = "Tap to record again";
      const { pcm, sr, deviceSr } = await Recorder.stop();
      const st = Recorder.stats(pcm, sr);
      if (c.url) URL.revokeObjectURL(c.url);
      Object.assign(c, { uploaded: null, blob: Recorder.wav(pcm, sr), dur: st.dur, deviceSr, stats: st, q: Recorder.judge(st, { minDur: lim.min, noiseFloorDb: S.noiseDb }) });
      if (c.kind === "word" && c.q.ok && st.dur > lim.max - 0.2) c.q = { ok: true, level: "meh", msg: "Just the word is enough" };
      c.url = URL.createObjectURL(c.blob);
      showTake(c, slot); onChange();
    }
  };
}

function showTake(c, slot) {
  slot.innerHTML = `<div class="take"><button class="play" aria-label="Play your recording">▶</button>
    <div class="meta"><b>${c.dur.toFixed(1)} s</b> · <span class="q-${c.q.level}">${esc(c.q.msg)}</span></div></div>`;
  const a = new Audio(c.url), p = $(".play", slot);
  p.onclick = () => (a.paused ? a.play() : (a.pause(), (a.currentTime = 0)));
  a.onplay = () => (p.textContent = "■"); a.onpause = a.onended = () => (p.textContent = "▶");
}

function stepDetails() {
  openDrawer(REC_STEPS, 4); stopLoops();
  const seg = (id, opts) => `<div class="seg" id="${id}">${opts.map((o) => `<button type="button" class="${S.details[id] === o ? "on" : ""}">${o}</button>`).join("")}</div>`;
  body().innerHTML = `<h2 id="drawer-title">A little about you</h2>
    <p class="lede">All optional. It helps researchers know whose voices are in the collection, and whose are missing.</p>
    <div class="field"><span class="lbl">Age</span>${seg("age", ["18–25", "26–40", "41–60", "60+"])}</div>
    <div class="field"><span class="lbl">Gender</span>${seg("gender", ["Woman", "Man", "Other", "Prefer not to say"])}</div>
    <div class="field"><label for="f-other">Other languages you speak</label><input type="text" id="f-other" placeholder="e.g. Hindi, English" value="${esc(S.details.other || "")}"></div>
    <div class="field"><span class="lbl">Where are you recording?</span>${seg("place", ["Indoors, quiet", "Indoors, noisy", "Outdoors"])}</div>
    <div id="ts-box"></div>
    <div class="nav"><button class="btn" id="back">Back</button><button class="btn primary" id="next">Light up ${esc(S.district.name)} ✨</button></div>`;
  if (LIVE && CFG.TURNSTILE_SITE_KEY) loadTurnstile().catch(() => {}); // warm up before the tap
  body().querySelectorAll(".seg").forEach((sg) => sg.onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const on = !b.classList.contains("on");
    sg.querySelectorAll("button").forEach((x) => x.classList.remove("on")); b.classList.toggle("on", on);
    S.details[sg.id] = on ? b.textContent : undefined;
  });
  $("#f-other").oninput = (e) => (S.details.other = e.target.value);
  $("#back").onclick = () => stepRecord(1);
  $("#next").onclick = async () => {
    const btn = $("#next"), label = btn.textContent;
    btn.disabled = true; $("#back").disabled = true; $("#up-err")?.remove();
    let meta;
    try { meta = await submitContribution((t) => (btn.textContent = t)); }
    catch (e) {
      console.error(e);
      btn.disabled = false; $("#back").disabled = false; btn.textContent = "Try again";
      btn.closest(".nav").insertAdjacentHTML("beforebegin", `<p class="warn" id="up-err">Couldn't upload (${esc(e.message || e)}).
        Your recordings are still here: check your connection and tap “Try again”.</p>`);
      return;
    }
    stepDone(meta);
  };
}

/* Upload: anonymous session -> 4 WAVs into recordings/<uid>/<code>/ -> one metadata row.
   Safe to call again after a failure: the same code is reused and finished clips are skipped. */
async function submitContribution(progress = () => {}) {
  const code = (S.code ||= newCode());
  const meta = {
    code, district: S.district, language: S.language, details: S.details,
    noise_floor_db: S.noiseDb == null ? null : +S.noiseDb.toFixed(1),
    device: { ua: navigator.userAgent.slice(0, 300), sample_rate: S.clips[0]?.deviceSr },
    clips: S.clips.map((c, i) => ({ n: i + 1, kind: c.kind, picture: c.picture, seconds: +c.dur.toFixed(2),
      speech_db: +c.stats.speechDb.toFixed(1), quality: c.q.level })),
  };
  if (!LIVE) { console.info("[mock upload] would send:", meta, S.clips.map((c) => c.blob)); await sleep(500); return meta; }

  progress("Connecting…");
  const uid = await retry(ensureSession);
  for (const [i, c] of S.clips.entries()) {
    const path = `${uid}/${code}/${i + 1}_${c.kind}_${c.picture}.wav`;
    meta.clips[i].path = path;
    if (c.uploaded === path) continue;
    progress(`Uploading ${i + 1} of ${S.clips.length}…`);
    await retry(async () => {
      const { error } = await sb.storage.from("recordings").upload(path, c.blob, { contentType: "audio/wav", upsert: false });
      if (error && !/exist/i.test(error.message)) throw error; // "already exists" = an earlier try got through
    });
    c.uploaded = path;
  }
  progress("Saving…");
  await retry(async () => {
    const { error } = await sb.from("contributions").insert({
      code, state: S.district.state, district_id: S.district.id, district_name: S.district.name, language: S.language,
      details: S.details, noise_floor_db: meta.noise_floor_db, device: meta.device, clips: meta.clips, app_version: CFG.APP_VERSION,
    });
    if (error && error.code !== "23505") throw error; // 23505 = row already saved by an earlier try
  });
  return meta;
}

function stepDone(meta) {
  openDrawer(0); Recorder.close();
  const f = lightOf(S.district.id); f.properties.n += 1;
  map.getSource("lights")?.setData(lights); renderStats();
  const n = f.properties.n, ord = (k) => k + (["th", "st", "nd", "rd"][(k % 100 > 10 && k % 100 < 14) ? 0 : k % 10] || "th");
  body().innerHTML = `<h2 id="drawer-title">Thank you!</h2>
    <div class="done-num">${ord(n)}</div>
    <p class="lede">You're the ${ord(n)} voice from <b>${esc(S.district.name)}</b>. Its light just got a little brighter.</p>
    <div class="field"><span class="lbl">Your reference code (quote it if you write to us)</span>
      <div class="take"><div class="meta" style="font:600 18px/1 var(--sans);color:var(--ink);letter-spacing:1px">${meta.code}</div></div></div>
    <div class="field"><span class="lbl">Your clips${LIVE ? " (uploaded — thank you)" : " (stay on this device in the mock-up)"}</span>
      ${S.clips.map((c, i) => `<div class="take" style="margin-bottom:6px"><button class="play" data-i="${i}" aria-label="Play clip ${i + 1}">▶</button>
        <div class="meta">${TASKS[i].label} · ${c.dur.toFixed(1)} s · <a href="${c.url}" download="${meta.code}_${i + 1}_${c.kind}.wav" style="color:var(--gold)">WAV</a></div></div>`).join("")}</div>
    <div class="nav"><button class="btn" id="share">Share</button><button class="btn primary" id="see">See your light</button></div>
    <div class="nav" style="margin-top:10px"><button class="btn block" id="again">Record another set</button></div>`;
  body().querySelectorAll(".play").forEach((p) => { const a = new Audio(S.clips[p.dataset.i].url); p.onclick = () => (a.paused ? a.play() : a.pause()); a.onplay = () => (p.textContent = "■"); a.onpause = a.onended = () => (p.textContent = "▶"); });
  const text = `I lent my voice to ${S.district.name}, ${S.district.state} — the ${ord(n)} voice from my district on the map of India's languages. Add yours!`;
  $("#share").onclick = async () => { try { if (navigator.share) await navigator.share({ text, url: location.href }); else { await navigator.clipboard.writeText(text + " " + location.href); toast("Copied — paste it on WhatsApp"); } } catch {} };
  $("#again").onclick = () => startRecord();
  $("#see").onclick = () => { $("#drawer").hidden = true; bloom(f); };
}

function bloom(f) {
  if (!map.getSource("me")) { $("#hero").classList.remove("away"); return; } // map not ready yet
  map.getSource("me").setData({ type: "FeatureCollection", features: [f] });
  map.flyTo({ center: f.geometry.coordinates, zoom: 6.2, padding: {}, duration: REDUCED ? 0 : 1600 });
  const go = () => {
    const t0 = performance.now();
    const h = loop(() => {
      const k = Math.min(1, (performance.now() - t0) / 2200);
      map.setPaintProperty("me-ring", "circle-radius", 6 + 60 * k);
      map.setPaintProperty("me-ring", "circle-stroke-opacity", 1 - k);
      map.setPaintProperty("me-ring", "circle-opacity", 0.25 * (1 - k));
      if (k >= 1) { h(); toast(`${f.properties.name} now has ${f.properties.n} voices ✨`); setTimeout(() => { $("#hero").classList.remove("away"); select(null); }, 1500); }
    });
  };
  REDUCED ? go() : map.once("moveend", go);
}

/* ===================== listen & check (mock) ===================== */
function startListen() {
  let i = 0, votes = 0;
  const clips = [...listenClips.clips].sort(() => Math.random() - 0.5);
  const show = () => {
    openDrawer(0);
    const c = clips[i % clips.length];
    body().innerHTML = `<h2 id="drawer-title">Listen &amp; check</h2>
      <p class="lede">No microphone needed. Listen to someone else's clip and tell us if it's good. Every check makes the collection more useful.</p>
      <div class="card"><div class="kind">Clip ${i + 1} · ${esc(c.where.replace(/([a-z])([A-Z])/g, "$1 $2"))}</div>
        <div class="say q">Is this clear speech in <b style="color:var(--gold)">${esc(c.language)}</b>?</div>
        <div class="take" style="margin-top:14px"><button class="play" aria-label="Play clip">▶</button><div class="meta">${c.duration.toFixed(1)} s · listen to the end</div></div></div>
      <div class="vote"><button class="btn" data-v="yes" disabled>👍 Yes</button><button class="btn" data-v="no" disabled>👎 No</button><button class="btn" data-v="unsure" disabled>Not sure</button></div>
      <p class="note" style="margin-top:14px">${votes} checked this session. Sample clips: Vaani (ARTPARK &amp; IISc), CC BY 4.0. In the real site these will be other contributors' recordings.</p>`;
    const a = new Audio(c.file), p = $(".take .play");
    p.onclick = () => (a.paused ? a.play() : a.pause()); a.onplay = () => (p.textContent = "■"); a.onpause = () => (p.textContent = "▶");
    a.onended = () => { p.textContent = "▶"; body().querySelectorAll(".vote .btn").forEach((b) => (b.disabled = false)); };
    body().querySelector(".vote").onclick = (e) => { const b = e.target.closest("button"); if (!b || b.disabled) return; a.pause(); votes++; i++; toast("Thanks!"); show(); };
  };
  show();
}

boot();
