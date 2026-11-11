import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { getAccessToken, serviceClient } from '../_shared/xero.ts'
import { syncContacts, syncInvoices } from '../_shared/xero-sync.ts'

// Called every morning by pg_cron (see sql/schedule_xero_daily_sync.sql). There is no user session
// here, so the caller proves itself with a shared secret instead. Deploy with --no-verify-jwt.

const safeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

serve(async (req) => {
  const secret = Deno.env.get('XERO_CRON_SECRET') ?? ''
  const given = req.headers.get('x-cron-secret') ?? ''
  if (!secret || !safeEqual(secret, given)) return new Response('Forbidden', { status: 403 })

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  try {
    const admin = serviceClient()
    const { accessToken, tenantId } = await getAccessToken(admin)

    // Clients first so new customers exist before their invoices arrive. Only once the first,
    // reviewed client sync has been approved in the admin page.
    const { data: conn } = await admin.from('xero_connection').select('clients_synced_at').eq('id', 1).maybeSingle()
    let clients: unknown = 'skipped (first sync not yet approved in admin)'
    if (conn?.clients_synced_at) {
      clients = await syncContacts(admin, accessToken, tenantId, { dryRun: false })
    }
    const invoices = await syncInvoices(admin, accessToken, tenantId)
    console.log('xero-cron', JSON.stringify({ clients, invoices }))
    return json({ clients, invoices })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('xero-cron failed', msg)
    return json({ error: msg }, 500)
  }
})
