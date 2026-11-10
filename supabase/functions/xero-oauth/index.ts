import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { exchangeCode, serviceClient } from '../_shared/xero.ts'

// Xero redirects the admin's browser here after they approve the connection. It's a plain
// browser redirect (no Authorization header), so this function is deployed with --no-verify-jwt;
// the one-time `state` saved by xero-api is what proves the request really came from our flow.
const ADMIN_URL = 'https://www.paytech.org.za/admin/'

const back = (result: string, detail = '') =>
  new Response(null, {
    status: 302,
    headers: { Location: `${ADMIN_URL}?xero=${result}${detail ? `&msg=${encodeURIComponent(detail)}` : ''}` },
  })

serve(async (req) => {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const xeroError = url.searchParams.get('error')
  if (xeroError) return back('error', xeroError)
  if (!code || !state) return back('error', 'Missing code or state')

  try {
    const admin = serviceClient()
    const { data: row } = await admin.from('xero_connection').select('oauth_state, oauth_state_expires').eq('id', 1).maybeSingle()
    if (!row?.oauth_state || row.oauth_state !== state || !row.oauth_state_expires || new Date(row.oauth_state_expires) < new Date()) {
      return back('error', 'This connection link expired or was not started from the admin portal. Try again.')
    }

    const t = await exchangeCode(code)

    const connRes = await fetch('https://api.xero.com/connections', {
      headers: { Authorization: `Bearer ${t.access_token}`, Accept: 'application/json' },
    })
    const tenants = (await connRes.json().catch(() => [])) as Array<{ tenantId: string; tenantName: string }>
    if (!connRes.ok || !tenants.length) return back('error', 'No Xero organisation was selected.')

    await admin
      .from('xero_connection')
      .update({
        tenant_id: tenants[0].tenantId,
        tenant_name: tenants[0].tenantName,
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(),
        oauth_state: null,
        oauth_state_expires: null,
        connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', 1)

    return back('connected')
  } catch (err) {
    return back('error', err instanceof Error ? err.message : String(err))
  }
})
