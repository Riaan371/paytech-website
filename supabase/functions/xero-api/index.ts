import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import {
  corsHeaders,
  createClient,
  getAccessToken,
  redirectUri,
  serviceClient,
  XERO_SCOPES,
  xeroFetch,
} from '../_shared/xero.ts'

// Admin-only. Every call re-verifies the caller's own session is a Paytech admin — the role is
// never taken from the request body.
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

    // ── Is Xero connected, and with which defaults? ──────────────────────────────
    if (action === 'status') {
      const { data: row } = await admin
        .from('xero_connection')
        .select('tenant_name, default_account_code, default_tax_type, connected_at, refresh_token')
        .eq('id', 1)
        .maybeSingle()
      return json({
        connected: Boolean(row?.refresh_token),
        tenantName: row?.tenant_name ?? null,
        defaultAccountCode: row?.default_account_code ?? null,
        defaultTaxType: row?.default_tax_type ?? null,
      })
    }

    // ── Start the approval: returns the Xero consent URL ─────────────────────────
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

    // ── Sales accounts + VAT types to choose from (read from Xero, not guessed) ──
    if (action === 'settings') {
      const { accessToken, tenantId } = await getAccessToken(admin)
      const accounts = await xeroFetch(accessToken, tenantId, 'Accounts?where=Class%3D%3D%22REVENUE%22')
      const taxes = await xeroFetch(accessToken, tenantId, 'TaxRates')
      if (!accounts.ok || !taxes.ok) return json({ error: `Xero said no (${accounts.status}/${taxes.status}). Reconnect and try again.` }, 502)
      return json({
        accounts: (accounts.json.Accounts ?? [])
          .filter((a: { Status: string; Code?: string }) => a.Status === 'ACTIVE' && a.Code)
          .map((a: { Code: string; Name: string }) => ({ code: a.Code, name: a.Name })),
        taxRates: (taxes.json.TaxRates ?? [])
          .filter((t: { Status: string; CanApplyToRevenue?: boolean }) => t.Status === 'ACTIVE' && t.CanApplyToRevenue !== false)
          .map((t: { TaxType: string; Name: string; EffectiveRate?: number }) => ({ taxType: t.TaxType, name: t.Name, rate: t.EffectiveRate ?? null })),
      })
    }

    if (action === 'save-defaults') {
      const { accountCode, taxType } = p as { accountCode?: string; taxType?: string }
      if (!accountCode || !taxType) return json({ error: 'accountCode and taxType are required.' }, 400)
      await admin.from('xero_connection').update({ default_account_code: accountCode, default_tax_type: taxType }).eq('id', 1)
      return json({ ok: true })
    }

    // ── Push one invoice to Xero (created as APPROVED / awaiting payment) ────────
    if (action === 'push-invoice') {
      const invoiceId = p.invoiceId as string | undefined
      if (!invoiceId) return json({ error: 'invoiceId is required.' }, 400)

      const { data: conn } = await admin.from('xero_connection').select('default_account_code, default_tax_type').eq('id', 1).maybeSingle()
      if (!conn?.default_account_code || !conn.default_tax_type) {
        return json({ error: 'Choose the sales account and VAT type in the Xero panel first.' }, 400)
      }

      const { data: inv, error: invErr } = await admin
        .from('invoices')
        .select('*, clients(id, company_name, email, xero_contact_id)')
        .eq('id', invoiceId)
        .single()
      if (invErr || !inv) return json({ error: 'Invoice not found.' }, 404)
      if (inv.xero_invoice_id) return json({ ok: true, alreadySynced: true, xeroInvoiceId: inv.xero_invoice_id })
      const client = inv.clients as { id: string; company_name: string; email: string | null; xero_contact_id: string | null }

      const fail = async (message: string, status = 502) => {
        await admin.from('invoices').update({ xero_error: message }).eq('id', invoiceId)
        return json({ error: message }, status)
      }

      const { accessToken, tenantId } = await getAccessToken(admin)

      // Find (or create) the client as a Xero contact, and remember its id.
      let contactId = client.xero_contact_id
      if (!contactId) {
        const name = client.company_name.replace(/"/g, '')
        const found = await xeroFetch(accessToken, tenantId, `Contacts?where=${encodeURIComponent(`Name=="${name}"`)}`)
        contactId = found.json?.Contacts?.[0]?.ContactID ?? null
        if (!contactId) {
          const created = await xeroFetch(accessToken, tenantId, 'Contacts', {
            method: 'POST',
            body: { Contacts: [{ Name: client.company_name, EmailAddress: client.email ?? undefined }] },
          })
          contactId = created.json?.Contacts?.[0]?.ContactID ?? null
          if (!contactId) return fail(`Could not create the client in Xero: ${JSON.stringify(created.json).slice(0, 200)}`)
        }
        await admin.from('clients').update({ xero_contact_id: contactId }).eq('id', client.id)
      }

      let lines: Array<{ desc?: string; qty?: number; price?: number }> = []
      try {
        lines = typeof inv.line_items === 'string' ? JSON.parse(inv.line_items) : (inv.line_items ?? [])
      } catch { /* handled below */ }
      lines = lines.filter((l) => l.desc || l.price)
      if (!lines.length) return fail('This invoice has no line items to send.', 400)

      const payload = {
        Invoices: [
          {
            Type: 'ACCREC',
            Contact: { ContactID: contactId },
            Date: inv.invoice_date,
            DueDate: inv.due_date ?? inv.invoice_date,
            InvoiceNumber: inv.invoice_number,
            Reference: inv.period ?? inv.invoice_number,
            LineAmountTypes: 'Exclusive',
            Status: 'AUTHORISED', // approved on arrival, per Paytech — not left as a draft
            LineItems: lines.map((l) => ({
              Description: l.desc || inv.period || 'Services',
              Quantity: l.qty ?? 1,
              UnitAmount: l.price ?? 0,
              AccountCode: conn.default_account_code,
              TaxType: conn.default_tax_type,
            })),
          },
        ],
      }
      const res = await xeroFetch(accessToken, tenantId, 'Invoices', {
        method: 'POST',
        body: payload,
        headers: { 'Idempotency-Key': `paytech-invoice-${invoiceId}` },
      })
      const created = res.json?.Invoices?.[0]
      if (!res.ok || !created?.InvoiceID) {
        const msg =
          created?.ValidationErrors?.map((e: { Message: string }) => e.Message).join('; ') ||
          res.json?.Message ||
          `Xero rejected the invoice (${res.status}).`
        return fail(msg)
      }

      await admin
        .from('invoices')
        .update({ xero_invoice_id: created.InvoiceID, xero_synced_at: new Date().toISOString(), xero_error: null })
        .eq('id', invoiceId)
      return json({ ok: true, xeroInvoiceId: created.InvoiceID })
    }

    return json({ error: 'Unknown action.' }, 400)
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})
