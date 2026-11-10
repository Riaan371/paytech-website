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

// Xero is the source of truth for invoices; this pulls them INTO the Paytech app (admin page and
// client portal both read the `invoices` table). Admin-only: every call re-verifies the caller's
// own session is a Paytech admin — the role is never taken from the request body.

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()

type XeroLine = { Description?: string; Quantity?: number; UnitAmount?: number; LineAmount?: number; TaxAmount?: number }
type XeroInvoice = {
  InvoiceID: string
  InvoiceNumber?: string
  Reference?: string
  Status: string
  DateString?: string
  DueDateString?: string
  SubTotal?: number
  TotalTax?: number
  Total?: number
  AmountDue?: number
  LineAmountTypes?: string
  LineItems?: XeroLine[]
  Contact?: { ContactID: string; Name?: string }
}

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
        .select('tenant_name, connected_at, invoices_synced_at, refresh_token')
        .eq('id', 1)
        .maybeSingle()
      return json({
        connected: Boolean(row?.refresh_token),
        tenantName: row?.tenant_name ?? null,
        lastSyncedAt: row?.invoices_synced_at ?? null,
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

    // ── Pull sales invoices from Xero into the app ───────────────────────────────
    if (action === 'sync-invoices') {
      const { accessToken, tenantId } = await getAccessToken(admin)
      const { data: conn } = await admin.from('xero_connection').select('invoices_synced_at').eq('id', 1).maybeSingle()
      // First run goes back 90 days; after that only what changed since the last good sync.
      const since = (p.since as string | undefined) ?? conn?.invoices_synced_at ?? new Date(Date.now() - 90 * 86_400_000).toISOString()
      const syncStartedAt = new Date().toISOString()

      const { data: clients } = await admin.from('clients').select('id, company_name, xero_contact_id, xero_contact_name')
      const byContactId = new Map<string, string>()
      const byName = new Map<string, string>()
      for (const c of clients ?? []) {
        if (c.xero_contact_id) byContactId.set(c.xero_contact_id, c.id)
        if (c.xero_contact_name) byName.set(norm(c.xero_contact_name), c.id)
        byName.set(norm(c.company_name), c.id)
      }

      const today = new Date().toISOString().slice(0, 10)
      let imported = 0
      let updated = 0
      const skipped = new Map<string, number>()

      for (let page = 1; page <= 30; page++) {
        const r = await xeroFetch(
          accessToken,
          tenantId,
          `Invoices?where=${encodeURIComponent('Type=="ACCREC"')}&Statuses=AUTHORISED,PAID,VOIDED&order=UpdatedDateUTC&page=${page}`,
          { headers: { 'If-Modified-Since': since.slice(0, 19) } },
        )
        if (r.status === 429) return json({ error: 'Xero is rate limiting us — try again in a minute.' }, 429)
        if (!r.ok) return json({ error: `Xero said no (${r.status}). Try reconnecting.` }, 502)
        const list = (r.json.Invoices ?? []) as XeroInvoice[]

        const ids = list.map((x) => x.InvoiceID)
        const nums = list.map((x) => x.InvoiceNumber).filter(Boolean) as string[]
        const { data: existingById } = ids.length
          ? await admin.from('invoices').select('id, xero_invoice_id').in('xero_invoice_id', ids)
          : { data: [] }
        const { data: existingByNum } = nums.length
          ? await admin.from('invoices').select('id, invoice_number, client_id, xero_invoice_id').in('invoice_number', nums)
          : { data: [] }

        for (const x of list) {
          const contact = x.Contact
          const clientId =
            (contact?.ContactID && byContactId.get(contact.ContactID)) || byName.get(norm(contact?.Name)) || null
          if (!clientId) {
            const label = contact?.Name || '(no contact)'
            skipped.set(label, (skipped.get(label) ?? 0) + 1)
            continue
          }
          if (contact?.ContactID && !byContactId.has(contact.ContactID)) {
            byContactId.set(contact.ContactID, clientId)
            await admin.from('clients').update({ xero_contact_id: contact.ContactID }).eq('id', clientId)
          }

          const dueDate = x.DueDateString?.slice(0, 10) ?? null
          const status =
            x.Status === 'PAID' ? 'Paid'
            : x.Status === 'VOIDED' ? 'Void'
            : (x.AmountDue ?? 0) > 0 && dueDate && dueDate < today ? 'Overdue'
            : 'Sent'

          const inclusive = x.LineAmountTypes === 'Inclusive'
          const lines = (x.LineItems ?? []).map((l) => {
            const qty = l.Quantity ?? 1
            return {
              desc: l.Description ?? '',
              qty,
              price: inclusive && qty ? ((l.LineAmount ?? 0) - (l.TaxAmount ?? 0)) / qty : (l.UnitAmount ?? 0),
            }
          })

          const row = {
            client_id: clientId,
            invoice_number: x.InvoiceNumber ?? x.InvoiceID,
            invoice_date: x.DateString?.slice(0, 10) ?? today,
            due_date: dueDate,
            period: x.Reference ?? null,
            status,
            subtotal: x.SubTotal ?? 0,
            vat: x.TotalTax ?? 0,
            total: x.Total ?? 0,
            line_items: JSON.stringify(lines),
            xero_invoice_id: x.InvoiceID,
            xero_synced_at: new Date().toISOString(),
            xero_error: null,
          }

          // Already synced → update. Same number from before Xero (not yet linked) → link it
          // rather than creating a duplicate. Otherwise → new.
          const match =
            (existingById ?? []).find((e) => e.xero_invoice_id === x.InvoiceID) ??
            (existingByNum ?? []).find((e) => e.invoice_number === row.invoice_number && e.client_id === clientId && !e.xero_invoice_id)
          if (match) {
            const { error } = await admin.from('invoices').update(row).eq('id', match.id)
            if (error) return json({ error: `Could not update invoice ${row.invoice_number}: ${error.message}` }, 500)
            updated++
          } else {
            const { error } = await admin.from('invoices').insert({ ...row, notes: '' })
            if (error) return json({ error: `Could not save invoice ${row.invoice_number}: ${error.message}` }, 500)
            imported++
          }
        }
        if (list.length < 100) break
      }

      await admin.from('xero_connection').update({ invoices_synced_at: syncStartedAt }).eq('id', 1)
      return json({
        imported,
        updated,
        skipped: [...skipped.entries()].map(([name, count]) => ({ name, count })),
      })
    }

    return json({ error: 'Unknown action.' }, 400)
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})
