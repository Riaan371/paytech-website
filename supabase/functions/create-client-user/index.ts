import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Only the real admin portal is allowed to call this — it creates real login credentials using
// the service-role key, so an open CORS policy (like payspace-proxy's) would be a real hole here.
const ALLOWED_ORIGINS = new Set([
  'https://www.paytech.org.za',
  'https://paytech.org.za',
  'https://paytech-website.pages.dev',
])

function corsHeaders(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://www.paytech.org.za'
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

// Not shown to the client until they set their own — readable-but-strong, since an admin may
// need to read it aloud over the phone.
function randomPassword(length = 14): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes, (b) => chars[b % chars.length]).join('')
}

serve(async (req) => {
  const cors = corsHeaders(req.headers.get('origin'))
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

  try {
    // Supabase injects these into every Edge Function automatically — no manual secret needed.
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    // Verify the CALLER is a genuinely logged-in admin — never trust a role claimed by the
    // request body itself, only what their own verified session says.
    const authHeader = req.headers.get('Authorization') ?? ''
    const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } })
    const {
      data: { user: caller },
      error: callerErr,
    } = await callerClient.auth.getUser()
    if (callerErr || !caller) return json({ error: 'Not authenticated.' }, 401)
    if (caller.user_metadata?.role !== 'admin') return json({ error: 'Admin access required.' }, 403)

    const { email, companyName } = (await req.json()) as { email?: string; companyName?: string }
    if (!email || !companyName) return json({ error: 'email and companyName are required.' }, 400)

    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })

    const { data: clientRow, error: clientErr } = await admin
      .from('clients')
      .select('id')
      .eq('company_name', companyName)
      .single()
    if (clientErr || !clientRow) return json({ error: `Could not find a client company named "${companyName}".` }, 404)

    const password = randomPassword()
    let userId: string
    let isNewUser = true

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { role: 'client' },
    })

    if (createErr) {
      // Most likely cause: this email already has a login. Reset their password and re-link
      // rather than failing outright — the admin gets a fresh password either way.
      if (createErr.message?.toLowerCase().includes('already') || createErr.status === 422) {
        const { data: existingProfile } = await admin.from('profiles').select('id').eq('email', email).maybeSingle()
        if (!existingProfile) {
          return json(
            {
              error:
                'A login with this email may already exist, but no matching profile was found. Check Supabase → Authentication → Users manually.',
            },
            409,
          )
        }
        userId = existingProfile.id
        isNewUser = false
        const { error: resetErr } = await admin.auth.admin.updateUserById(userId, {
          password,
          user_metadata: { role: 'client' },
        })
        if (resetErr) return json({ error: `Found the existing login but could not reset its password: ${resetErr.message}` }, 500)
      } else {
        return json({ error: createErr.message }, 500)
      }
    } else {
      userId = created.user.id
    }

    const { error: profileErr } = await admin
      .from('profiles')
      .upsert({ id: userId, email, role: 'client', client_id: clientRow.id }, { onConflict: 'id' })
    if (profileErr) return json({ error: `Login created, but linking it to the client failed: ${profileErr.message}` }, 500)

    return json({ email, password, isNewUser })
  } catch (err) {
    return json({ error: String(err) }, 500)
  }
})
