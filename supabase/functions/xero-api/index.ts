import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import {
  corsHeaders,
  createClient,
  getAccessToken,
  redirectUri,
  serviceClient,
  XERO_SCOPES,
} from '../_shared/xero.ts'
import { syncContacts, syncInvoices } from '../_shared/xero-sync.ts'

// Xero is the source of truth for clients and invoices; this pulls them INTO the Paytech app
// (admin page and client portal both read the `clients` / `invoices` tables). Admin-only: every
// call re-verifies the caller's own session is a Paytech admin — the role is never taken from
// the request body.

serve(async (req) => {
  const cors = corsHeaders(req.headers.get('origin'))
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

  try {
    const callerClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    })
    const {
      data: { user: caller },
      error: callerErr,
    } = await callerClient.auth.getUser()
    if (callerErr || !caller) return json({ error: 'Not authenticated.' }, 401)
    if (caller.user_metadata?.role !== 'admin') return json({ error: 'Admin access required.' }, 403)

    const { action, ...p } = (await req.json()) as Record<string, unknown>
    const admin = serviceClient()

    if (action === 'status') {
      const { data: row } = await admin
        .from('xero_connection')
        .select('tenant_name, connected_at, invoices_synced_at, clients_synced_at, refresh_token')
        .eq('id', 1)
        .maybeSingle()
      return json({
        connected: Boolean(row?.refresh_token),
        tenantName: row?.tenant_name ?? null,
        lastSyncedAt: row?.invoices_synced_at ?? null,
        clientsSyncedAt: row?.clients_synced_at ?? null,
      })
    }

    if (action === 'authorize-url') {
      const state = crypto.randomUUID()
      const { error } = await admin
        .from('xero_connection')
        .upsert({ id: 1, oauth_state: state, oauth_state_expires: new Date(Date.now() + 10 * 60_000).toISOString() }, { onConflict: 'id' })
      if (error) return json({ error: error.message }, 500)
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: Deno.env.get('XERO_CLIENT_ID') ?? '',
        redirect_uri: redirectUri(),
        scope: XERO_SCOPES,
        state,
      })
      return json({ url: `https://login.xero.com/identity/connect/authorize?${params}` })
    }

    // ── Pull customers from Xero into the clients list ────────────────────────────
    // dryRun=true only reports what WOULD change (used for the first, reviewed run).
    if (action === 'sync-clients') {
      const { accessToken, tenantId } = await getAccessToken(admin)
      const result = await syncContacts(admin, accessToken, tenantId, { dryRun: p.dryRun === true })
      if ('error' in result) return json({ error: result.error }, result.status)
      return json(result)
    }

    // ── Pull sales invoices from Xero into the app ───────────────────────────────
    if (action === 'sync-invoices') {
      const { accessToken, tenantId } = await getAccessToken(admin)
      const result = await syncInvoices(admin, accessToken, tenantId, { since: p.since as string | undefined })
      if ('error' in result) return json({ error: result.error }, result.status)
      return json(result)
    }

    return json({ error: 'Unknown action.' }, 400)
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})
