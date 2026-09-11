import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const { action, ...p } = await req.json()

    // ── Token request ─────────────────────────────────────────────
    if (action === 'token') {
      const params: Record<string, string> = {
        grant_type:    'client_credentials',
        client_id:     p.client_id,
        client_secret: p.client_secret,
      }
      if (p.scope) params.scope = p.scope;
      const body = new URLSearchParams(params)
      const res  = await fetch(p.token_url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      })
      const json = await res.json()
      return new Response(JSON.stringify(json), {
        status:  res.status,
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }

    // ── Document upload ──────────────────────────────────────────
    if (action === 'upload') {
      const res = await fetch(p.upload_url, {
        method:  'POST',
        headers: {
          'Authorization': 'Bearer ' + p.token,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify(p.payload),
      })
      const text = await res.text()
      return new Response(text, {
        status:  res.status,
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), {
      status:  400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status:  500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }
})
