import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

export const ALLOWED_ORIGINS = new Set([
  'https://www.paytech.org.za',
  'https://paytech.org.za',
  'https://paytech-website.pages.dev',
])

export function corsHeaders(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://www.paytech.org.za'
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

export function serviceClient() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  })
}

// Granular scopes only — apps created after March 2026 can't use the old broad ones.
export const XERO_SCOPES = 'offline_access accounting.invoices accounting.contacts accounting.settings.read'

export function redirectUri() {
  return `${Deno.env.get('SUPABASE_URL')}/functions/v1/xero-oauth`
}

function basicAuth() {
  const id = Deno.env.get('XERO_CLIENT_ID')
  const secret = Deno.env.get('XERO_CLIENT_SECRET')
  if (!id || !secret) throw new Error('XERO_CLIENT_ID / XERO_CLIENT_SECRET are not set as Supabase secrets.')
  return `Basic ${btoa(`${id}:${secret}`)}`
}

type TokenResponse = { access_token: string; refresh_token: string; expires_in: number }

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Xero token request failed (${res.status}): ${body.error ?? JSON.stringify(body)}`)
  return body as TokenResponse
}

export const exchangeCode = (code: string) =>
  tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() })

type Admin = ReturnType<typeof serviceClient>

// Returns a valid access token, refreshing if needed. Xero refresh tokens are SINGLE USE — the
// new one is saved straight away or the connection would be lost on the next refresh.
export async function getAccessToken(admin: Admin): Promise<{ accessToken: string; tenantId: string }> {
  const { data: row } = await admin.from('xero_connection').select('*').eq('id', 1).maybeSingle()
  if (!row?.refresh_token || !row.tenant_id) throw new Error('Xero is not connected yet.')
  if (row.access_token && row.expires_at && new Date(row.expires_at).getTime() > Date.now() + 60_000) {
    return { accessToken: row.access_token, tenantId: row.tenant_id }
  }
  let t: TokenResponse
  try {
    t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: row.refresh_token })
  } catch (err) {
    throw new Error(`Xero connection expired — click "Connect to Xero" again. (${err instanceof Error ? err.message : err})`)
  }
  await admin
    .from('xero_connection')
    .update({
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', 1)
  return { accessToken: t.access_token, tenantId: row.tenant_id }
}

export async function xeroFetch(
  accessToken: string,
  tenantId: string,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const res = await fetch(`https://api.xero.com/api.xro/2.0/${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'xero-tenant-id': tenantId,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, json }
}

export { createClient }
