'use strict';

// ── State ────────────────────────────────────────────────────────────────────
let phase = 'idle'; // idle | recording | paused | stopped

// Transcription state
let txEnabled     = localStorage.getItem('txEnabled') !== 'false'; // on by default
let txLang        = localStorage.getItem('txLang') || '';
let recognition   = null;
let txFinalText   = '';
let txInterimText = '';
let txSecs        = 0;   // seconds elapsed at moment of each final result (for timestamps)
const txSupported = !!(window.SpeechRecognition || window.webkitSpeechRecognition);

// Device detection
const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

// PCM capture (for WAV encoding)
let stream         = null;
let audioCtx       = null;
let analyser       = null;
let scriptProc     = null;      // desktop only
let mobileRecorder = null;      // mobile only — MediaRecorder avoids mic-lock conflict with SpeechRecognition
let mobileChunks   = [];        // mobile only — raw MediaRecorder blobs
// Groq transcription endpoint stored per-device in localStorage ('txEndpoint')
let lastSavedId    = null;      // ID of last autoSaved recording (for Whisper transcript update)
let capturing      = false;     // true only while actively recording (not paused)
let pcmChunks      = [];        // desktop only — Float32Array chunks of raw PCM
let wavSampleRate  = 44100;

// Output
let wavBlob  = null;
let wavUrl   = null;

// Waveform canvas
let canvasW  = 0;
let canvasH  = 0;
let bars     = 80;
let history  = [];
let rafId    = null;

// Timer
let startTs     = 0;
let totalPaused = 0;
let pauseTs     = 0;
let finalSecs   = 0;
let timerTick   = null;

// IndexedDB
let db = null;

// ── DOM ──────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const D = {
  recBadge:    $('recBadge'),
  canvas:      $('waveCanvas'),
  idleHint:    $('idleHint'),
  timer:       $('timer'),
  controls:    $('controls'),
  ctrlIdle:    $('ctrlIdle'),
  ctrlRec:     $('ctrlRecording'),
  ctrlPaused:  $('ctrlPaused'),
  recordBtn:   $('recordBtn'),
  pauseBtn:    $('pauseBtn'),
  stopBtn:     $('stopBtn'),
  stopBtn2:    $('stopBtn2'),
  resumeBtn:   $('resumeBtn'),
  reviewPanel: $('reviewPanel'),
  audioPlayer: $('audioPlayer'),
  recInfo:     $('recInfo'),
  localActions:$('localActions'),
  downloadBtn: $('downloadBtn'),
  shareBtn:    $('shareBtn'),
  newBtn:      $('newBtn'),
  // Groq setup modal (mobile)
  openGroqModal: $('openGroqModal'),
  groqModal:     $('groqModal'),
  closeGroqModal:$('closeGroqModal'),
  groqApiKeyInput:$('groqApiKeyInput'),
  saveGroqKey:   $('saveGroqKey'),
  historyCount:$('historyCount'),
  clearAllBtn: $('clearAllBtn'),
  historyEmpty:$('historyEmpty'),
  historyList: $('historyList'),
  // Transcription
  txToggle:         $('txToggle'),
  langSelect:       $('langSelect'),
  transcriptWrap:   $('transcriptWrap'),
  transcriptScroll: $('transcriptScroll'),
  transcriptEditWrap: $('transcriptEditWrap'),
  transcriptEdit:   $('transcriptEdit'),
  txActions:        $('txActions'),
  txCopyBtn:        $('txCopyBtn'),
  txDownloadBtn:    $('txDownloadBtn'),
  // Whisper (Android post-recording)
  whisperProgress:  $('whisperProgress'),
  whisperStatusText:$('whisperStatusText'),
  whisperBarWrap:   $('whisperBarWrap'),
  whisperBarFill:   $('whisperBarFill'),
};
const ctx = D.canvas.getContext('2d');

// ── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  setupCanvas();
  bindEvents();
  initTranscription();
  applyTxToggleUI();
  drawIdle();
  initMicTip();
  await initDB();
  // Clear all saved recordings on page load for privacy (each session starts fresh)
  await dbClear();
  localStorage.removeItem('recCounter');
  await refreshHistory();
}

// ── Canvas ───────────────────────────────────────────────────────────────────
function setupCanvas() {
  const onResize = () => {
    const wrap = D.canvas.parentElement;
    const rect = wrap.getBoundingClientRect();
    const dpr  = window.devicePixelRatio || 1;
    canvasW = rect.width;
    canvasH = rect.height;
    D.canvas.width  = Math.floor(canvasW * dpr);
    D.canvas.height = Math.floor(canvasH * dpr);
    D.canvas.style.width  = canvasW + 'px';
    D.canvas.style.height = canvasH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bars    = Math.max(40, Math.floor((canvasW - 16) / 6));
    history = new Array(bars).fill(0);
    if (phase === 'idle') drawIdle();
    else drawBars(phase === 'recording');
  };
  onResize();
  window.addEventListener('resize', onResize);
}

// ── Events ────────────────────────────────────────────────────────────────────
function bindEvents() {
  document.getElementById('installBtn')?.addEventListener('click', doInstall);

  // Groq setup modal — only shown on mobile
  if (!isMobile) {
    D.openGroqModal.hidden = true;
  } else {
    D.openGroqModal.addEventListener('click', openGroqSetup);
    D.closeGroqModal.addEventListener('click', () => { D.groqModal.hidden = true; });
    D.saveGroqKey.addEventListener('click', saveGroqApiKey);
    D.groqModal.addEventListener('click', e => { if (e.target === D.groqModal) D.groqModal.hidden = true; });
    // Load saved key into input
    const saved = localStorage.getItem('groqApiKey') || '';
    if (saved) D.groqApiKeyInput.value = saved;
  }

  D.recordBtn.addEventListener('click', startRec);
  D.pauseBtn.addEventListener('click',  pauseRec);
  D.resumeBtn.addEventListener('click', resumeRec);
  D.stopBtn.addEventListener('click',   stopRec);
  D.stopBtn2.addEventListener('click',  stopRec);

  D.downloadBtn.addEventListener('click', doDownload);
  D.shareBtn.addEventListener('click',    doShare);
  D.newBtn.addEventListener('click',      resetAll);

  D.clearAllBtn.addEventListener('click', clearAllRecordings);

  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if (e.target.isContentEditable) return;
    if (e.code === 'Space')  { e.preventDefault(); onSpace(); }
    if (e.code === 'Escape' || e.code === 'KeyS') onEscape();
  });
}

function onSpace()  {
  if (phase === 'idle')      startRec();
  else if (phase === 'recording') pauseRec();
  else if (phase === 'paused')    resumeRec();
}
function onEscape() {
  if (phase === 'recording' || phase === 'paused') stopRec();
}


// ── Transcription ─────────────────────────────────────────────────────────────
function initTranscription() {
  // On mobile, Whisper handles transcription — SpeechRecognition not needed.
  // On desktop, hide toggle if SpeechRecognition is unavailable.
  if (!txSupported && !isMobile) {
    D.txToggle.hidden = true;
    return;
  }
  if (txLang) D.langSelect.value = txLang;

  D.txToggle.addEventListener('click', () => {
    txEnabled = !txEnabled;
    localStorage.setItem('txEnabled', String(txEnabled));
    applyTxToggleUI();
  });

  D.langSelect.addEventListener('change', () => {
    txLang = D.langSelect.value;
    localStorage.setItem('txLang', txLang);
    if (recognition && phase === 'recording') {
      txStopRecognition();
      txStartRecognition();
    }
  });

  D.txCopyBtn.addEventListener('click', doCopyTranscript);
  D.txDownloadBtn.addEventListener('click', doDownloadTranscript);
}

function applyTxToggleUI() {
  D.txToggle.classList.toggle('tx-on', txEnabled);
  D.txToggle.setAttribute('aria-pressed', String(txEnabled));
  D.langSelect.classList.toggle('hidden', !txEnabled);
  document.querySelector('.app').classList.toggle('tx-active', txEnabled);
}

// ── Whisper (post-recording transcription — Android) ─────────────────────────
// ── Groq Transcription (via Cloudflare Worker proxy) ─────────────────────────
// Language codes for Groq Whisper (ISO 639-1)
const GROQ_LANG = {
  'en-US':'en','en-GB':'en','es':'es','es-MX':'es',
  'fr':'fr','de':'de','it':'it','pt-BR':'pt','pt':'pt',
  'zh':'zh','ja':'ja',
};

const GROQ_API_URL  = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_CHUNK_S  = 240;   // 4 minutes per chunk — well under the 25 MB Groq limit
const GROQ_SAMPLE_HZ = 16000; // 16 kHz — sufficient for speech, ~3x smaller than 44.1 kHz

// ── Groq API key management ───────────────────────────────────────────────────
function openGroqSetup() {
  const saved = localStorage.getItem('groqApiKey') || '';
  D.groqApiKeyInput.value = saved;
  D.groqModal.hidden = false;
}

function saveGroqApiKey() {
  const key = D.groqApiKeyInput.value.trim();
  if (key) {
    localStorage.setItem('groqApiKey', key);
    D.groqModal.hidden = true;
  } else {
    D.groqApiKeyInput.focus();
  }
}

// Mobile: send WebM blob directly to Groq (no resampling — avoids OfflineAudioContext on Android).
// Desktop: decode WAV, split into 4-min chunks at 16 kHz via OfflineAudioContext.
async function startGroqTranscription(audioBlob) {
  const apiKey = localStorage.getItem('groqApiKey') || '';
  D.whisperProgress.classList.remove('hidden');
  D.whisperBarWrap.classList.add('hidden');

  // If no API key, prompt user to configure it
  if (!apiKey) {
    D.whisperProgress.classList.add('hidden');
    openGroqSetup();
    return;
  }

  try {
    const lang = GROQ_LANG[txLang] || null;

    // ── Mobile path: send WebM directly — already compressed, Groq supports it ──
    if (isMobile) {
      D.whisperStatusText.textContent = 'Transcribiendo…';
      const form = new FormData();
      form.append('file', audioBlob, 'recording.webm');
      form.append('model', 'whisper-large-v3');
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'segment');
      if (lang) form.append('language', lang);

      const res = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });

      if (!res.ok) {
        const errText = await res.text();
        if (res.status === 401) {
          localStorage.removeItem('groqApiKey');
          throw new Error('API key inválida. Toca ⚙ y actualiza tu clave de Groq.');
        }
        throw new Error(`Error ${res.status}: ${errText.slice(0, 200)}`);
      }

      const data = await res.json();
      let text = '';
      if (data.segments?.length > 0) {
        for (const seg of data.segments) {
          const t = (seg.text || '').trim();
          if (t) text += `[${fmtTime(Math.floor(seg.start))}] ${t}\n`;
        }
      } else if (data.text) {
        text = data.text.trim();
      }
      await finishTranscription(text, null);
      return;
    }

    // ── Desktop path: decode WAV + chunk at 16 kHz via OfflineAudioContext ──
    D.whisperStatusText.textContent = 'Preparando audio…';

    const arrayBuf  = await audioBlob.arrayBuffer();
    const decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuf  = await decodeCtx.decodeAudioData(arrayBuf);
    await decodeCtx.close();

    const totalDuration = audioBuf.duration;
    const numChunks     = Math.ceil(totalDuration / GROQ_CHUNK_S);
    let   fullText      = '';

    for (let i = 0; i < numChunks; i++) {
      const startS    = i * GROQ_CHUNK_S;
      const endS      = Math.min(startS + GROQ_CHUNK_S, totalDuration);
      const chunkSecs = endS - startS;

      D.whisperStatusText.textContent = numChunks > 1
        ? `Transcribiendo parte ${i + 1} de ${numChunks}…`
        : 'Transcribiendo…';

      const frames = Math.ceil(chunkSecs * GROQ_SAMPLE_HZ);
      const offCtx = new OfflineAudioContext(1, frames, GROQ_SAMPLE_HZ);
      const src    = offCtx.createBufferSource();
      src.buffer   = audioBuf;
      src.start(0, startS, chunkSecs);
      src.connect(offCtx.destination);
      const resampled = await offCtx.startRendering();
      const chunkWav  = encodePCM([resampled.getChannelData(0)], GROQ_SAMPLE_HZ);

      const form = new FormData();
      form.append('file', chunkWav, 'recording.wav');
      form.append('model', 'whisper-large-v3');
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'segment');
      if (lang) form.append('language', lang);

      const res = await fetch(GROQ_API_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });

      if (!res.ok) {
        const errText = await res.text();
        // If 401, the key is invalid — prompt user to update it
        if (res.status === 401) {
          localStorage.removeItem('groqApiKey');
          throw new Error('API key inválida. Ve a ⚙ Configuración y actualiza tu clave de Groq.');
        }
        throw new Error(`Error ${res.status}: ${errText.slice(0, 200)}`);
      }

      const data = await res.json();
      if (data.segments && data.segments.length > 0) {
        for (const seg of data.segments) {
          const ts = `[${fmtTime(Math.floor(seg.start + startS))}] `;
          const t  = (seg.text || '').trim();
          if (t) fullText += ts + t + '\n';
        }
      } else if (data.text) {
        const t = data.text.trim();
        if (t) fullText += (numChunks > 1 ? `[${fmtTime(Math.floor(startS))}] ` : '') + t + '\n';
      }
    }

    await finishTranscription(fullText.trim(), null);

  } catch (err) {
    console.error('[Groq] transcription error:', err);
    await finishTranscription('', err.message);
  }
}

async function finishTranscription(text, errorMsg) {
  D.whisperProgress.classList.add('hidden');

  if (errorMsg) {
    // Show error persistently in the transcript area so it doesn't disappear
    D.transcriptEdit.textContent = '⚠ ' + errorMsg;
    D.transcriptEdit.contentEditable = 'false';
    D.transcriptEditWrap.classList.remove('hidden');
    D.txActions.classList.add('hidden');
    return;
  }
  if (!text || !text.trim()) {
    // Show "no speech" persistently in the transcript area
    D.transcriptEdit.textContent = '⚠ No speech detected. Check that the microphone captured audio and the recording is not silent.';
    D.transcriptEdit.contentEditable = 'false';
    D.transcriptEditWrap.classList.remove('hidden');
    D.txActions.classList.add('hidden');
    return;
  }

  D.transcriptEdit.textContent = text.trim();
  D.transcriptEdit.contentEditable = 'true';
  D.transcriptEditWrap.classList.remove('hidden');
  D.txActions.classList.remove('hidden');

  if (lastSavedId && db) {
    await dbUpdateTranscript(lastSavedId, text.trim());
    await refreshHistory();
  }
}

// Shows a small diagnostic badge in the transcript area (mobile only)
function txDbg(msg) {
  if (!isMobile) return;
  const el = document.getElementById('txDbgBadge');
  if (el) { el.textContent = '⚙ ' + msg; el.hidden = false; }
}

function showTxUnsupportedBanner() {
  const b = document.createElement('div');
  b.style.cssText = [
    'position:fixed', 'bottom:72px', 'left:12px', 'right:12px',
    'background:#1c1c1e', 'border:1px solid #f87171', 'border-radius:10px',
    'padding:12px 14px', 'color:#f87171', 'font-size:13px',
    'z-index:300', 'line-height:1.5'
  ].join(';');
  b.innerHTML = '<strong>⚠ Transcripción no disponible</strong><br>'
    + 'SpeechRecognition no está soportado en este navegador. '
    + 'Prueba con <strong>Chrome</strong> (no Samsung Browser ni Firefox).';
  document.body.appendChild(b);
}

function txCreateRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.continuous      = true;
  recognition.interimResults  = true;
  recognition.maxAlternatives = 1;
  recognition.lang = txLang || navigator.language;

  recognition.onresult = e => {
    if (phase !== 'recording') return; // ignore results while paused
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) {
        const stamp = `[${fmtTime(elapsedSecs())}] `;
        txFinalText += stamp + r[0].transcript.trim() + '\n';
      } else {
        interim += r[0].transcript;
      }
    }
    txInterimText = interim;
    renderTranscriptPanel();
  };

  recognition.onstart = () => {
    txDbg('onstart ✓');
    if (phase === 'recording' && !txFinalText && !txInterimText) {
      D.transcriptScroll.innerHTML = '<span class="tx-placeholder">Listening…</span>';
    }
  };

  recognition.onend = () => {
    txDbg('onend — restarting…');
    if (phase === 'recording' && txEnabled) {
      setTimeout(() => {
        if (phase === 'recording' && txEnabled) txStartRecognition();
      }, 300);
    }
  };

  recognition.onerror = e => {
    txDbg('onerror: ' + e.error);
    const MSGS = {
      'not-allowed':         'Mic not allowed — check browser permissions',
      'service-not-allowed': 'Speech service blocked — try a different browser',
      'audio-capture':       'Mic busy — retrying…',
      'network':             'Network error — check connection',
    };
    const msg = MSGS[e.error] || ('Error: ' + e.error);
    if (phase === 'recording') {
      D.transcriptScroll.innerHTML = `<span class="tx-placeholder" style="color:#f87171">⚠ ${msg}</span>`;
    }

    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      txEnabled = false;
      localStorage.setItem('txEnabled', 'false');
      applyTxToggleUI();
    } else if (e.error === 'audio-capture' || e.error === 'network') {
      setTimeout(() => {
        if (phase === 'recording' && txEnabled) txStartRecognition();
      }, 800);
    }
  };
}

function txStartRecognition() {
  if (!txSupported || !txEnabled) return;
  if (!recognition) txCreateRecognition();
  recognition.lang = txLang || navigator.language;
  txDbg('start() lang=' + recognition.lang);
  try {
    recognition.start();
  } catch (err) {
    txDbg('start() threw: ' + err.name);
    if (err.name !== 'InvalidStateError') console.warn('tx start:', err);
  }
}

function txStopRecognition() {
  if (!recognition) return;
  try { recognition.stop(); } catch {}
}

function txAbortRecognition() {
  if (!recognition) return;
  try { recognition.abort(); } catch {}
  recognition = null;
}

function renderTranscriptPanel() {
  const scroll = D.transcriptScroll;
  const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 30;

  if (!txFinalText && !txInterimText) {
    scroll.innerHTML = '<span class="tx-placeholder">Listening…</span>';
  } else {
    let html = '';
    if (txFinalText)   html += `<span class="tx-final">${escHtml(txFinalText)}</span>`;
    if (txInterimText) html += `<span class="tx-interim">${escHtml(txInterimText)}</span>`;
    scroll.innerHTML = html;
  }

  if (atBottom) scroll.scrollTop = scroll.scrollHeight;
}

async function doCopyTranscript() {
  const text = (D.transcriptEdit.innerText || D.transcriptEdit.textContent || '').trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    D.txCopyBtn.classList.add('copied');
    D.txCopyBtn.childNodes[1].textContent = ' Copied!';
    setTimeout(() => {
      D.txCopyBtn.classList.remove('copied');
      D.txCopyBtn.childNodes[1].textContent = ' Copy';
    }, 2000);
  } catch { /* clipboard not available */ }
}

function doDownloadTranscript() {
  const text = (D.transcriptEdit.innerText || D.transcriptEdit.textContent || '').trim();
  if (!text) return;
  const stamp    = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  const filename = `transcript-${stamp}.txt`;
  const blob     = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url      = URL.createObjectURL(blob);
  const a        = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}


// ── WAV encoder ───────────────────────────────────────────────────────────────
function encodePCM(chunks, sampleRate) {
  // Flatten all Float32Array chunks
  let totalLen = 0;
  for (const c of chunks) totalLen += c.length;
  const pcm = new Float32Array(totalLen);
  let off = 0;
  for (const c of chunks) { pcm.set(c, off); off += c.length; }

  const numCh = 1, bps = 16;
  const blockAlign = numCh * (bps / 8);
  const byteRate   = sampleRate * blockAlign;
  const dataSize   = pcm.length * 2; // int16

  const buf  = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);

  const w4 = (o, s) => { for (let i = 0; i < 4; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  w4(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); w4(8, 'WAVE');
  w4(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);        // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bps, true);
  w4(36, 'data'); view.setUint32(40, dataSize, true);

  let o = 44;
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(o, s < 0 ? s * 32768 : s * 32767, true);
    o += 2;
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// ── Recording ─────────────────────────────────────────────────────────────────
async function startRec() {

  if (isMobile) {
    // ── MOBILE PATH ─────────────────────────────────────────────────────────
    // No AudioContext on mobile — it can conflict with SpeechRecognition at OS level.
    // Order: recognition first → getUserMedia → MediaRecorder.

    phase = 'recording'; startTs = Date.now(); totalPaused = 0;
    setUI('recording'); startTimer(); startViz(); // fake waveform, no analyser

    if (txEnabled) {
      txFinalText = ''; txInterimText = '';
      D.transcriptWrap.classList.remove('hidden');
      D.transcriptScroll.innerHTML =
        '<span class="tx-placeholder">Transcription will appear after recording…</span>';
      // Mobile: Whisper runs after recording. No SpeechRecognition needed.
    }

    const tracksAlive = stream && stream.getTracks().every(t => t.readyState === 'live');
    if (!tracksAlive) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,  // boosts quiet voices automatically
          }
        });
      } catch (err) {
        phase = 'idle'; setUI('idle'); stopTimer(); stopViz();
        return handleMicError(err);
      }
    }

    mobileChunks = [];
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus' : '';
    mobileRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    mobileRecorder.ondataavailable = e => { if (e.data.size > 0) mobileChunks.push(e.data); };
    mobileRecorder.onstop = async () => {
      const webmBlob = new Blob(mobileChunks, { type: mobileRecorder.mimeType });
      try {
        const arrayBuf = await webmBlob.arrayBuffer();
        const tempCtx  = new (window.AudioContext || window.webkitAudioContext)();
        const audioBuf = await tempCtx.decodeAudioData(arrayBuf);
        await tempCtx.close();
        wavSampleRate = audioBuf.sampleRate;
        wavBlob = encodePCM([audioBuf.getChannelData(0)], wavSampleRate);
      } catch (err) {
        console.warn('Mobile audio decode failed:', err);
        // Fallback: keep raw WebM so user can at least play/download it
        wavBlob = webmBlob;
      }

      // Show review panel immediately (audio player + download ready)
      await buildWAV();

      // Send original WebM to Groq — much smaller than WAV, chunked for long recordings
      if (txEnabled) startGroqTranscription(webmBlob);
    };
    mobileRecorder.start(500);
    return;
  }

  // ── DESKTOP PATH ──────────────────────────────────────────────────────────
  const tracksAlive = stream && stream.getTracks().every(t => t.readyState === 'live');
  if (!tracksAlive) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) { return handleMicError(err); }
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  wavSampleRate = audioCtx.sampleRate;

  const src = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.82;
  src.connect(analyser);

  scriptProc = audioCtx.createScriptProcessor(4096, 1, 1);
  const muted = audioCtx.createGain(); muted.gain.value = 0;
  src.connect(scriptProc);
  scriptProc.connect(muted);
  muted.connect(audioCtx.destination);
  pcmChunks = [];
  capturing = true;
  scriptProc.onaudioprocess = e => {
    if (!capturing) return;
    pcmChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };

  phase = 'recording'; startTs = Date.now(); totalPaused = 0;
  setUI('recording'); startTimer(); startViz();

  if (txEnabled) {
    txFinalText = ''; txInterimText = '';
    D.transcriptWrap.classList.remove('hidden');
    D.transcriptScroll.innerHTML = '<span class="tx-placeholder">Listening…</span>';
    txStartRecognition();
  }
}

function pauseRec() {
  if (phase !== 'recording') return;
  capturing = false;
  phase     = 'paused';
  pauseTs   = Date.now();
  stopTimer();
  stopViz();
  setUI('paused');
  if (isMobile && mobileRecorder && mobileRecorder.state === 'recording') mobileRecorder.pause();
  // Leave recognition running during pause — results are ignored while phase !== 'recording'
  if (txEnabled) {
    txInterimText = '';
    renderTranscriptPanel();
  }
}

function resumeRec() {
  if (phase !== 'paused') return;
  totalPaused += Date.now() - pauseTs;
  capturing = true;
  phase     = 'recording';
  startTimer();
  startViz();
  setUI('recording');
  if (isMobile && mobileRecorder && mobileRecorder.state === 'paused') mobileRecorder.resume();
  // Recognition kept running during pause — no restart needed
}

function stopRec() {
  if (phase !== 'recording' && phase !== 'paused') return;
  finalSecs = elapsedSecs();
  capturing = false;
  stopTimer();
  stopViz();

  // Rescue any interim text not yet confirmed as final (happens on short recordings)
  if (txEnabled && txInterimText.trim()) {
    const stamp = `[${fmtTime(elapsedSecs())}] `;
    txFinalText += stamp + txInterimText.trim() + '\n';
  }
  txInterimText = '';
  // Keep recognition instance alive — reusing same object avoids Chrome re-prompting for mic.
  // It will stop naturally (onend fires) but won't restart while phase !== 'recording'.

  phase = 'stopped';
  setUI('stopped');

  if (isMobile && mobileRecorder) {
    // mobileRecorder.onstop decodes the audio and calls buildWAV() asynchronously
    if (mobileRecorder.state === 'paused') mobileRecorder.resume();
    mobileRecorder.stop();
    // No audioCtx on mobile — it was never created
    return; // buildWAV() will be called from mobileRecorder.onstop
  }

  // Desktop path
  // Do NOT stop stream tracks — keep mic permission alive for next recording.
  // Tracks are released on page unload (see beforeunload handler in PWA section).
  if (scriptProc) { scriptProc.disconnect(); scriptProc = null; }
  if (audioCtx)   { audioCtx.close(); audioCtx = null; }
  buildWAV(); // Desktop: SpeechRecognition transcript shown inside buildWAV()
}

async function buildWAV() {
  // Encode on next tick so UI updates first
  await new Promise(r => setTimeout(r, 0));

  // Mobile sets wavBlob before calling buildWAV (via mobileRecorder.onstop decode)
  if (!wavBlob) wavBlob = encodePCM(pcmChunks, wavSampleRate);
  pcmChunks = [];
  mobileChunks = [];
  mobileRecorder = null;
  wavUrl = URL.createObjectURL(wavBlob);

  D.audioPlayer.src = wavUrl;
  D.recInfo.textContent = `${fmtTime(finalSecs)} · ${fmtSize(wavBlob.size)} · WAV`;

  D.localActions.classList.remove('hidden');
  const testFile = new File([], 'test.wav', { type: 'audio/wav' });
  D.shareBtn.style.display =
    (navigator.share && navigator.canShare && navigator.canShare({ files: [testFile] })) ? '' : 'none';

  // Populate transcript area
  D.transcriptWrap.classList.add('hidden');
  D.whisperProgress.classList.add('hidden'); // reset from any previous run

  if (isMobile && txEnabled) {
    // Mobile: Groq will fill transcript after buildWAV() — keep area hidden for now
    D.transcriptEditWrap.classList.add('hidden');
    D.txActions.classList.add('hidden');
  } else if (!isMobile && txEnabled && txFinalText.trim()) {
    // Desktop: Web Speech API transcript available immediately
    D.transcriptEdit.textContent = txFinalText.trim();
    D.transcriptEdit.contentEditable = 'true';
    D.transcriptEditWrap.classList.remove('hidden');
    D.txActions.classList.remove('hidden');
  } else {
    D.transcriptEditWrap.classList.add('hidden');
    D.txActions.classList.add('hidden');
  }

  D.reviewPanel.hidden = false;
  drawBars(false);

  // Auto-save to history
  await autoSave();
}

// ── Timer ─────────────────────────────────────────────────────────────────────
function startTimer() { timerTick = setInterval(() => { D.timer.textContent = fmtTime(elapsedSecs()); }, 200); }
function stopTimer()  { clearInterval(timerTick); }

function elapsedSecs() {
  if (phase === 'recording') return Math.floor((Date.now() - startTs - totalPaused) / 1000);
  if (phase === 'paused')    return Math.floor((pauseTs - startTs - totalPaused) / 1000);
  return finalSecs;
}

function fmtTime(s) {
  return `${String(Math.floor(s / 60)).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
}
function fmtSize(b) {
  if (b < 1024)         return `${b} B`;
  if (b < 1024 * 1024)  return `${(b/1024).toFixed(1)} KB`;
  return `${(b/1024/1024).toFixed(1)} MB`;
}
function fmtDate(iso) {
  const d   = new Date(iso);
  const now = Date.now();
  const diff = now - d;
  if (diff < 60000)     return 'Just now';
  if (diff < 3600000)   return `${Math.floor(diff/60000)}m ago`;
  if (diff < 86400000)  return `${Math.floor(diff/3600000)}h ago`;
  if (diff < 172800000) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ── Waveform ──────────────────────────────────────────────────────────────────
function startViz() {
  D.idleHint.style.opacity = '0';
  // Mobile has no AudioContext/analyser — use synthetic waveform animation
  if (isMobile) { vizLoopMobile(); } else { vizLoop(); }
}
function stopViz() { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }
function vizLoop() {
  if (phase !== 'recording') return;
  const buf = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) { const v = (buf[i]-128)/128; sum += v*v; }
  const amp = Math.min(1, Math.sqrt(sum/buf.length) * 6);
  history.push(amp);
  if (history.length > bars) history.shift();
  drawBars(true);
  rafId = requestAnimationFrame(vizLoop);
}
function vizLoopMobile() {
  if (phase !== 'recording') { return; }
  const t = Date.now() / 250;
  const amp = Math.max(0.05, 0.35 + Math.sin(t) * 0.2 + Math.sin(t * 2.3) * 0.1 + (Math.random() - 0.5) * 0.12);
  history.push(amp);
  if (history.length > bars) history.shift();
  drawBars(true);
  rafId = requestAnimationFrame(vizLoopMobile);
}

function drawBars(live) {
  ctx.clearRect(0, 0, canvasW, canvasH);
  const bw = 3, gap = 2, step = bw + gap;
  const count  = history.length;
  const startX = (canvasW - (count * step - gap)) / 2;
  const cy = canvasH / 2, maxH = canvasH * 0.78, minH = 2;

  for (let i = 0; i < count; i++) {
    const amp   = history[i];
    const bh    = minH + amp * (maxH - minH);
    const x     = startX + i * step;
    const prog  = (i + 1) / count;
    const alpha = live ? 0.2 + prog * 0.8 : 0.08 + prog * 0.32;
    ctx.fillStyle = live ? `rgba(255,59,48,${alpha})` : `rgba(140,140,150,${alpha})`;
    roundRect(x, cy - bh/2, bw, bh, bw/2);
  }
}

function drawIdle() {
  ctx.clearRect(0, 0, canvasW, canvasH);
  D.idleHint.style.opacity = '1';
  const bw = 3, gap = 2, step = bw + gap;
  const startX = (canvasW - (bars * step - gap)) / 2;
  const cy = canvasH / 2;
  for (let i = 0; i < bars; i++) {
    ctx.fillStyle = 'rgba(80,80,90,0.22)';
    roundRect(startX + i * step, cy - 1, bw, 2, 1);
  }
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); }
  else {
    ctx.moveTo(x+r, y);
    ctx.arcTo(x+w,y, x+w,y+h, r); ctx.arcTo(x+w,y+h, x,y+h, r);
    ctx.arcTo(x,y+h, x,y, r);     ctx.arcTo(x,y, x+w,y, r);
    ctx.closePath();
  }
  ctx.fill();
}

// ── UI transitions ────────────────────────────────────────────────────────────
function setUI(state) {
  const show = id => $(id) && $(id).classList.remove('hidden');
  const hide = id => $(id) && $(id).classList.add('hidden');
  switch (state) {
    case 'recording':
      D.recBadge.hidden = false;
      show('ctrlRecording'); hide('ctrlIdle'); hide('ctrlPaused');
      D.controls.classList.remove('hidden');
      D.reviewPanel.hidden = true;
      break;
    case 'paused':
      D.recBadge.hidden = true;
      show('ctrlPaused'); hide('ctrlRecording');
      break;
    case 'stopped':
      D.recBadge.hidden = true;
      D.controls.classList.add('hidden');
      // reviewPanel shown after WAV is built
      break;
    case 'idle':
      D.recBadge.hidden = true;
      show('ctrlIdle'); hide('ctrlRecording'); hide('ctrlPaused');
      D.controls.classList.remove('hidden');
      D.reviewPanel.hidden = true;
      D.transcriptWrap.classList.add('hidden');
      D.transcriptEditWrap.classList.add('hidden');
      D.txActions.classList.add('hidden');
      D.timer.textContent = '00:00';
      history = new Array(bars).fill(0);
      drawIdle();
      break;
  }
}

// ── File actions ──────────────────────────────────────────────────────────────
function recFileName(dateIso) {
  const stamp = (dateIso || new Date().toISOString()).replace(/[:.]/g,'-').slice(0,19);
  return `recording-${stamp}.wav`;
}

function doDownload() {
  const a = document.createElement('a');
  a.href = wavUrl; a.download = recFileName(); a.click();
}

async function doShare() {
  const file = new File([wavBlob], recFileName(), { type: 'audio/wav' });
  try { await navigator.share({ title: 'Recording for NotebookLM', files: [file] }); }
  catch (e) { if (e.name !== 'AbortError') doDownload(); }
}


// ── IndexedDB ─────────────────────────────────────────────────────────────────
function initDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('grabtolm', 1);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('meta'))  d.createObjectStore('meta',  { keyPath: 'id' });
      if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs', { keyPath: 'id' });
    };
    req.onsuccess = e => { db = e.target.result; resolve(); };
    req.onerror   = () => reject(req.error);
  });
}

function dbSave(meta, blob) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['meta','blobs'], 'readwrite');
    tx.objectStore('meta').put(meta);
    tx.objectStore('blobs').put({ id: meta.id, blob });
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}

function dbGetAll() {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(['meta'], 'readonly');
    const req = tx.objectStore('meta').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function dbGetBlob(id) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(['blobs'], 'readonly');
    const req = tx.objectStore('blobs').get(id);
    req.onsuccess = () => resolve(req.result?.blob);
    req.onerror   = () => reject(req.error);
  });
}

function dbDelete(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['meta','blobs'], 'readwrite');
    tx.objectStore('meta').delete(id);
    tx.objectStore('blobs').delete(id);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}

function dbClear() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['meta','blobs'], 'readwrite');
    tx.objectStore('meta').clear();
    tx.objectStore('blobs').clear();
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}

// ── History management ────────────────────────────────────────────────────────
function nextRecName() {
  const n = (parseInt(localStorage.getItem('recCounter') || '0')) + 1;
  localStorage.setItem('recCounter', String(n));
  return `Recording ${n}`;
}

async function autoSave() {
  if (!db || !wavBlob) return;
  const id   = 'rec-' + Date.now();
  lastSavedId = id; // Groq will call dbUpdateTranscript(id, text) when done
  const date = new Date().toISOString();
  // Transcript is always filled in after recording by Groq — save empty now, update later
  const meta = { id, name: nextRecName(), date, duration: finalSecs, size: wavBlob.size, transcript: '' };
  await dbSave(meta, wavBlob);
  await refreshHistory();
}

async function refreshHistory() {
  if (!db) return;
  let items = [];
  try { items = await dbGetAll(); } catch { return; }
  items.sort((a, b) => new Date(b.date) - new Date(a.date));
  renderHistory(items);
}

function renderHistory(items) {
  const count = items.length;

  // Update header
  if (count > 0) {
    D.historyCount.textContent = count;
    D.historyCount.hidden = false;
    D.clearAllBtn.hidden = false;
  } else {
    D.historyCount.hidden = true;
    D.clearAllBtn.hidden = true;
  }

  D.historyEmpty.hidden = count > 0;

  D.historyList.innerHTML = items.map(item => `
    <div class="hist-item" data-id="${item.id}">
      <div class="hist-info">
        <span class="hist-name">${escHtml(item.name)}</span>
        <span class="hist-meta">${fmtDate(item.date)} · ${fmtTime(item.duration)} · ${fmtSize(item.size)}</span>
        ${item.transcript ? `<span class="hist-tx-preview">${escHtml(item.transcript.slice(0,70))}${item.transcript.length > 70 ? '…' : ''}</span>` : ''}
      </div>
      <div class="hist-actions">
        ${item.transcript ? `
        <button class="hist-btn tx-hist-btn" data-id="${item.id}" title="Ver/editar transcripción">
          <svg width="10" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>
        </button>` : ''}
        <button class="hist-btn play-btn" data-id="${item.id}" title="Play">
          <svg width="9" height="10" viewBox="0 0 10 12" fill="currentColor"><polygon points="0,0 10,6 0,12"/></svg>
        </button>
        <button class="hist-btn dl-btn" data-id="${item.id}" data-date="${item.date}" title="Download WAV">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
        </button>
        <button class="hist-btn del-btn" data-id="${item.id}" title="Delete">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </div>
    </div>
  `).join('');

  D.historyList.querySelectorAll('.tx-hist-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      const meta = items.find(i => i.id === btn.dataset.id);
      if (meta) showHistTranscript(btn.dataset.id, meta.transcript || '', meta.name, btn);
    }));
  D.historyList.querySelectorAll('.play-btn').forEach(btn =>
    btn.addEventListener('click', () => playHistItem(btn.dataset.id, btn)));
  D.historyList.querySelectorAll('.dl-btn').forEach(btn =>
    btn.addEventListener('click', () => downloadHistItem(btn.dataset.id, btn.dataset.date)));
  D.historyList.querySelectorAll('.del-btn').forEach(btn =>
    btn.addEventListener('click', () => deleteHistItem(btn.dataset.id)));
}

async function playHistItem(id, btn) {
  // Toggle: if mini-player already open in this item, close it
  const item   = btn.closest('.hist-item');
  const existing = item.querySelector('.hist-player');
  if (existing) { existing.remove(); return; }

  // Close any other open players
  document.querySelectorAll('.hist-player').forEach(p => p.remove());

  const blob = await dbGetBlob(id);
  if (!blob) return;
  const url    = URL.createObjectURL(blob);
  const div    = document.createElement('div');
  div.className = 'hist-player';
  div.innerHTML = `<audio src="${url}" controls autoplay></audio>`;
  const audio  = div.querySelector('audio');
  audio.onended = () => { URL.revokeObjectURL(url); div.remove(); };
  item.appendChild(div);
}

async function downloadHistItem(id, dateIso) {
  const blob = await dbGetBlob(id);
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = recFileName(dateIso); a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function deleteHistItem(id) {
  await dbDelete(id);
  await refreshHistory();
}

function showHistTranscript(id, transcript, name, triggerBtn) {
  const item = document.querySelector(`.hist-item[data-id="${id}"]`);
  const existing = item.querySelector('.hist-tx-editor');

  // Toggle: close if already open
  if (existing) {
    existing.remove();
    triggerBtn && triggerBtn.classList.remove('open');
    return;
  }

  // Close any other open editors
  document.querySelectorAll('.hist-tx-editor').forEach(e => e.remove());
  document.querySelectorAll('.tx-hist-btn.open').forEach(b => b.classList.remove('open'));
  triggerBtn && triggerBtn.classList.add('open');

  const div = document.createElement('div');
  div.className = 'hist-tx-editor';

  const ta = document.createElement('textarea');
  ta.className = 'hist-tx-area';
  ta.spellcheck = true;
  ta.value = transcript;

  const actions = document.createElement('div');
  actions.className = 'hist-tx-edit-actions';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'hist-tx-save';
  saveBtn.textContent = 'Save changes';
  saveBtn.addEventListener('click', async () => {
    await dbUpdateTranscript(id, ta.value);
    saveBtn.textContent = '✓ Saved';
    setTimeout(() => { saveBtn.textContent = 'Save changes'; }, 1500);
  });

  const dlBtn = document.createElement('button');
  dlBtn.className = 'hist-tx-dl';
  dlBtn.textContent = '↓ .txt';
  dlBtn.title = 'Download as plain text';
  dlBtn.addEventListener('click', () => {
    const text = ta.value.trim();
    if (!text) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const blob  = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url   = URL.createObjectURL(blob);
    const a     = document.createElement('a');
    a.href = url; a.download = `transcript-${stamp}.txt`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  const closeBtn = document.createElement('button');
  closeBtn.className = 'hist-tx-close';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', () => {
    div.remove();
    triggerBtn && triggerBtn.classList.remove('open');
  });

  actions.append(saveBtn, dlBtn, closeBtn);
  div.append(ta, actions);
  item.appendChild(div);
  ta.focus();
}

function dbUpdateTranscript(id, newText) {
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(['meta'], 'readwrite');
    const store = tx.objectStore('meta');
    const req   = store.get(id);
    req.onsuccess = () => {
      const meta = req.result;
      if (meta) { meta.transcript = newText; store.put(meta); }
    };
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}

async function clearAllRecordings() {
  if (!confirm('Delete all recordings? This cannot be undone.')) return;
  await dbClear();
  localStorage.removeItem('recCounter');
  await refreshHistory();
}

// ── Mic permission tip ────────────────────────────────────────────────────────
function initMicTip() {
  const tip = document.getElementById('micTip');
  if (!tip) return;
  if (localStorage.getItem('micTipDismissed') === 'true') { tip.remove(); return; }
  tip.hidden = false;
}
function dismissMicTip() {
  localStorage.setItem('micTipDismissed', 'true');
  const tip = document.getElementById('micTip');
  if (tip) tip.remove();
}

// ── Reset ─────────────────────────────────────────────────────────────────────
function resetAll() {
  if (wavUrl) { URL.revokeObjectURL(wavUrl); wavUrl = null; }
  wavBlob = null; pcmChunks = []; mobileChunks = [];
  if (mobileRecorder && mobileRecorder.state !== 'inactive') {
    mobileRecorder.ondataavailable = null; // prevent onstop from calling buildWAV after reset
    mobileRecorder.onstop = null;
    mobileRecorder.stop();
  }
  mobileRecorder = null;
  txFinalText = ''; txInterimText = '';
  D.transcriptEdit.textContent = '';
  D.transcriptEdit.contentEditable = 'false';
  phase = 'idle';
  setUI('idle');
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function handleMicError(err) {
  const msg = err.name === 'NotAllowedError' ? 'Microphone access denied. Allow it in browser settings.'
            : err.name === 'NotFoundError'   ? 'No microphone found. Connect one and try again.'
            : `Microphone error: ${err.message}`;
  alert(msg);
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── PWA ───────────────────────────────────────────────────────────────────────
let installPrompt = null;

// Intercept the browser's native install prompt to show our custom button
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  const btn = document.getElementById('installBtn');
  if (btn) btn.hidden = false;
});

// Hide button after successful install
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  const btn = document.getElementById('installBtn');
  if (btn) btn.hidden = true;
});

async function doInstall() {
  if (!installPrompt) return;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  if (outcome === 'accepted') {
    installPrompt = null;
    const btn = document.getElementById('installBtn');
    if (btn) btn.hidden = true;
  }
}

// Register SW and listen for updates
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(reg => {
    // Check for updates every time the page regains focus
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) reg.update();
    });
  }).catch(() => {});

  // Show a subtle "update available" toast when new SW activates
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type === 'SW_UPDATED') {
      const toast = document.createElement('div');
      toast.className = 'update-toast';
      toast.innerHTML = 'Nueva versión disponible. <button onclick="location.reload()">Actualizar</button>';
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 8000);
    }
  });
}

// Handle shortcut: ?action=record — auto-start recording when launched from shortcut
window.addEventListener('load', () => {
  if (new URLSearchParams(location.search).get('action') === 'record') {
    setTimeout(startRec, 600);
  }
});

// Release mic when page is closed/refreshed
window.addEventListener('beforeunload', () => {
  if (stream) stream.getTracks().forEach(t => t.stop());
});

// ── Boot ──────────────────────────────────────────────────────────────────────
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
