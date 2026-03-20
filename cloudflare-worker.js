/**
 * GrabtoLM — Cloudflare Worker (Groq Whisper proxy)
 * ──────────────────────────────────────────────────
 * HOW TO DEPLOY (5 minutes, free):
 *
 * 1. Create a free account at https://cloudflare.com
 * 2. Go to Workers & Pages → Create Application → Create Worker
 * 3. Replace the default code with this entire file
 * 4. Click "Save and Deploy"
 * 5. Go to the Worker's Settings → Variables → add a secret:
 *      Name:  GROQ_API_KEY
 *      Value: your Groq API key (get one free at https://console.groq.com)
 * 6. Copy the Worker URL (e.g. https://grabtolm-tx.YOUR-NAME.workers.dev)
 * 7. Open GrabtoLM → ⚙ Settings → paste the URL in "Transcription Endpoint"
 *
 * FREE LIMITS:
 *   - Cloudflare Workers: 100,000 requests/day (free)
 *   - Groq free tier: ~8 hours of audio/day (more than enough for personal use)
 */

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: cors });
    }

    if (!env.GROQ_API_KEY) {
      return new Response(
        JSON.stringify({ error: 'GROQ_API_KEY not configured. Add it as a Worker secret.' }),
        { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } }
      );
    }

    try {
      const formData = await request.formData();
      const audioFile = formData.get('file');
      const language  = formData.get('language') || null;

      if (!audioFile) {
        return new Response(
          JSON.stringify({ error: 'No audio file provided. Send FormData with field "file".' }),
          { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } }
        );
      }

      // Forward to Groq Whisper API
      const groqForm = new FormData();
      groqForm.append('file', audioFile, audioFile.name || 'recording.wav');
      groqForm.append('model', 'whisper-large-v3');
      groqForm.append('response_format', 'verbose_json');
      groqForm.append('timestamp_granularities[]', 'segment');
      if (language) groqForm.append('language', language);

      const groqRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
        body: groqForm,
      });

      const body = await groqRes.text();

      return new Response(body, {
        status: groqRes.status,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });

    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } }
      );
    }
  },
};
