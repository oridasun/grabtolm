// Whisper post-recording transcription worker
// Uses @xenova/transformers (v2) with Xenova/whisper-tiny (multilingual, ~75 MB, cached after first download)
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js';

env.allowLocalModels  = false;
env.useBrowserCache   = true;   // Cache model in IndexedDB after first download

let transcriber = null;

// Map from app lang codes → Whisper language names
const LANG_MAP = {
  'en-US': 'english', 'en-GB': 'english',
  'es':    'spanish', 'es-MX': 'spanish',
  'fr':    'french',  'de':    'german',
  'it':    'italian', 'pt-BR': 'portuguese',
  'pt':    'portuguese', 'zh': 'chinese',
  'ja':    'japanese',
};

function fmtTime(s) {
  if (s == null || isNaN(s)) return '00:00';
  const m   = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// Parse our PCM WAV (44-byte header + 16-bit mono samples) into Float32Array
function parsePCMWav(buffer) {
  const view       = new DataView(buffer);
  const sampleRate = view.getUint32(24, true);
  const numSamples = (buffer.byteLength - 44) / 2;
  const float32    = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    float32[i] = view.getInt16(44 + i * 2, true) / 32768.0;
  }
  return { float32, sampleRate };
}

async function getTranscriber() {
  if (transcriber) return transcriber;

  transcriber = await pipeline(
    'automatic-speech-recognition',
    'Xenova/whisper-tiny',
    {
      progress_callback: (p) => {
        if (p.status === 'initiate') {
          self.postMessage({ type: 'download', file: p.file || '', progress: 0 });
        } else if (p.status === 'progress' && p.total > 0) {
          self.postMessage({
            type:     'download',
            file:     p.file || '',
            progress: Math.round((p.loaded / p.total) * 100),
          });
        } else if (p.status === 'done') {
          self.postMessage({ type: 'download', file: p.file || '', progress: 100 });
        }
      },
    }
  );
  return transcriber;
}

self.onmessage = async ({ data }) => {
  if (data.type !== 'transcribe') return;

  try {
    self.postMessage({ type: 'status', text: 'Loading model…' });
    const pipe = await getTranscriber();

    self.postMessage({ type: 'status', text: 'Analyzing audio…' });

    const { float32, sampleRate } = parsePCMWav(data.wavBuffer);
    const whisperLang = LANG_MAP[data.lang] || null;

    const result = await pipe(
      { data: float32, sampling_rate: sampleRate },
      {
        language:       whisperLang,
        task:           'transcribe',
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: true,
      }
    );

    // Format output with timestamps
    let text = '';
    if (result.chunks && result.chunks.length > 0) {
      for (const chunk of result.chunks) {
        const start = chunk.timestamp?.[0];
        const ts    = (start != null && !isNaN(start)) ? `[${fmtTime(start)}] ` : '';
        const t     = chunk.text.trim();
        if (t) text += ts + t + '\n';
      }
    } else {
      text = result.text.trim();
    }

    self.postMessage({ type: 'done', text: text.trim() });

  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
