import { serviceClient, xeroFetch } from './xero.ts'

type Admin = ReturnType<typeof serviceClient>

// Company names rarely match character for character ("Swordfish Software (Pty) Ltd" vs
// "Swordfish Software Pty Ltd"), so compare with punctuation and legal suffixes stripped.
export const norm = (s: string | null | undefined) =>
  (s ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(pty|ltd|limited|proprietary|cc|inc|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

// ───────────────────────────── CLIENTS (Xero contacts → Paytech clients) ─────────────────────────────

type XeroContact = {
  ContactID: string
  Name?: string
  FirstName?: string
  LastName?: string
  EmailAddress?: string
  TaxNumber?: string
  AccountNumber?: string
  ContactStatus?: string
  IsSupplier?: boolean
  IsCustomer?: boolean
  Phones?: Array<{ PhoneType?: string; PhoneNumber?: string; PhoneAreaCode?: string; PhoneCountryCode?: string }>
  Addresses?: Array<{ AddressType?: string; AddressLine1?: string; AddressLine2?: string; AddressLine3?: string; AddressLine4?: string; City?: string; Region?: string; PostalCode?: string }>
  ContactPersons?: Array<{ FirstName?: string; LastName?: string }>
}

const clean = (s?: string | null) => (s && s.trim() ? s.trim() : null)

function phoneOf(c: XeroContact): string | null {
  const pick = (type: string) => c.Phones?.find((p) => p.PhoneType === type && p.PhoneNumber)
  const p = pick('MOBILE') ?? pick('DEFAULT') ?? c.Phones?.find((x) => x.PhoneNumber)
  if (!p) return null
  return [p.PhoneCountryCode, p.PhoneAreaCode, p.PhoneNumber].filter(Boolean).join(' ').trim() || null
}

function addressOf(c: XeroContact): string | null {
  const a = c.Addresses?.find((x) => x.AddressType === 'STREET') ?? c.Addresses?.find((x) => x.AddressType === 'POBOX')
  if (!a) return null
  const s = [a.AddressLine1, a.AddressLine2, a.AddressLine3, a.AddressLine4, a.City, a.Region, a.PostalCode]
    .map(clean)
    .filter(Boolean)
    .join(', ')
  return s || null
}

function personOf(c: XeroContact): string | null {
  const direct = [c.FirstName, c.LastName].map(clean).filter(Boolean).join(' ')
  if (direct) return direct
  const p = c.ContactPersons?.[0]
  return p ? [p.FirstName, p.LastName].map(clean).filter(Boolean).join(' ') || null : null
}

export type ClientSyncResult = {
  dryRun: boolean
  total: number
  linked: string[]
  created: string[]
  updated: number
  archived: string[]
  restored: string[]
}

// Xero is the source of truth for who the clients are and their company details. Paytech-only
// fields (service type, fee, WhatsApp switch, notes, portal logins) are never touched here.
// Existing clients are matched by Xero ID, else by company name, and only ever linked — never
// deleted. With dryRun nothing is written, so the first run can be reviewed before it happens.
export async function syncContacts(
  admin: Admin,
  accessToken: string,
  tenantId: string,
  opts: { dryRun: boolean },
): Promise<ClientSyncResult | { error: string; status: number }> {
  const contacts: XeroContact[] = []
  for (let page = 1; page <= 40; page++) {
    const r = await xeroFetch(accessToken, tenantId, `Contacts?includeArchived=true&page=${page}`)
    if (r.status === 429) return { error: 'Xero is rate limiting us — try again in a minute.', status: 429 }
    if (!r.ok) return { error: `Xero said no (${r.status}) reading contacts. Try reconnecting.`, status: 502 }
    const list = (r.json.Contacts ?? []) as XeroContact[]
    contacts.push(...list)
    if (list.length < 100) break
  }
  // Customers and not-yet-flagged contacts; pure suppliers aren't clients.
  const wanted = contacts.filter((c) => c.IsCustomer === true || c.IsSupplier !== true)

  const { data: existing } = await admin
    .from('clients')
    .select('id, company_name, xero_contact_id, archived')
  const byXeroId = new Map<string, { id: string; archived: boolean | null }>()
  const byName = new Map<string, { id: string; archived: boolean | null; linked: boolean }>()
  for (const c of existing ?? []) {
    if (c.xero_contact_id) byXeroId.set(c.xero_contact_id, { id: c.id, archived: c.archived })
    byName.set(norm(c.company_name), { id: c.id, archived: c.archived, linked: Boolean(c.xero_contact_id) })
  }

  const res: ClientSyncResult = { dryRun: opts.dryRun, total: wanted.length, linked: [], created: [], updated: 0, archived: [], restored: [] }
  const claimedClientIds = new Set<string>()
  const now = new Date().toISOString()

  for (const c of wanted) {
    const name = clean(c.Name)
    if (!name) continue
    const isArchivedInXero = c.ContactStatus === 'ARCHIVED'

    // Fields Xero owns. Empty values in Xero never blank out what Paytech already has.
    const fields: Record<string, unknown> = { company_name: name, xero_contact_id: c.ContactID, xero_synced_at: now }
    const extras: Record<string, string | null> = {
      contact_person: personOf(c),
      email: clean(c.EmailAddress),
      phone: phoneOf(c),
      vat_number: clean(c.TaxNumber),
      address: addressOf(c),
      xero_account_number: clean(c.AccountNumber),
    }
    for (const [k, v] of Object.entries(extras)) if (v) fields[k] = v

    let match = byXeroId.get(c.ContactID)
    let isNewLink = false
    if (!match) {
      const n = byName.get(norm(name))
      if (n && !n.linked && !claimedClientIds.has(n.id)) {
        match = { id: n.id, archived: n.archived }
        isNewLink = true
      }
    }

    if (match) {
      claimedClientIds.add(match.id)
      if (isNewLink) res.linked.push(name)
      else res.updated++
      if (isArchivedInXero && !match.archived) res.archived.push(name)
      if (!isArchivedInXero && match.archived) res.restored.push(name)
      if (!opts.dryRun) {
        const { error } = await admin.from('clients').update({ ...fields, archived: isArchivedInXero }).eq('id', match.id)
        if (error) return { error: `Could not update client ${name}: ${error.message}`, status: 500 }
      }
    } else {
      res.created.push(name)
      if (!opts.dryRun) {
        const { error } = await admin.from('clients').insert({
          ...fields,
          contact_person: extras.contact_person ?? name,
          email: extras.email ?? '',
          service_type: 'Payroll Consulting',
          monthly_fee: 0,
          employees: 0,
          invoice_day: 1,
          whatsapp_payslip_enabled: false,
          notes: '',
          archived: isArchivedInXero,
        })
        if (error) return { error: `Could not create client ${name}: ${error.message}`, status: 500 }
      }
    }
  }

  if (!opts.dryRun) await admin.from('xero_connection').update({ clients_synced_at: now }).eq('id', 1)
  return res
}

// ───────────────────────────── INVOICES (Xero → Paytech) ─────────────────────────────

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

export type InvoiceSyncResult = { imported: number; updated: number; skipped: Array<{ name: string; count: number }> }

export async function syncInvoices(
  admin: Admin,
  accessToken: string,
  tenantId: string,
  opts: { since?: string } = {},
): Promise<InvoiceSyncResult | { error: string; status: number }> {
  const { data: conn } = await admin.from('xero_connection').select('invoices_synced_at').eq('id', 1).maybeSingle()
  // First run goes back 90 days; after that only what changed since the last clean sync.
  const since = opts.since ?? conn?.invoices_synced_at ?? new Date(Date.now() - 90 * 86_400_000).toISOString()
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
    if (r.status === 429) return { error: 'Xero is rate limiting us — try again in a minute.', status: 429 }
    if (!r.ok) return { error: `Xero said no (${r.status}). Try reconnecting.`, status: 502 }
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
      const clientId = (contact?.ContactID && byContactId.get(contact.ContactID)) || byName.get(norm(contact?.Name)) || null
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

      // Already synced → update. Same number from before Xero (not yet linked) → link it rather
      // than creating a duplicate. Otherwise → new.
      const match =
        (existingById ?? []).find((e) => e.xero_invoice_id === x.InvoiceID) ??
        (existingByNum ?? []).find((e) => e.invoice_number === row.invoice_number && e.client_id === clientId && !e.xero_invoice_id)
      if (match) {
        const { error } = await admin.from('invoices').update(row).eq('id', match.id)
        if (error) return { error: `Could not update invoice ${row.invoice_number}: ${error.message}`, status: 500 }
        updated++
      } else {
        const { error } = await admin.from('invoices').insert({ ...row, notes: '' })
        if (error) return { error: `Could not save invoice ${row.invoice_number}: ${error.message}`, status: 500 }
        imported++
      }
    }
    if (list.length < 100) break
  }

  // Only move the "since" marker forward when nothing was skipped: a skipped invoice hasn't changed
  // in Xero, so once its client exists it would never be fetched again if we had moved past it.
  if (skipped.size === 0) {
    await admin.from('xero_connection').update({ invoices_synced_at: syncStartedAt }).eq('id', 1)
  }
  return { imported, updated, skipped: [...skipped.entries()].map(([name, count]) => ({ name, count })) }
}
