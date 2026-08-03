// ============================================================
// Bulk-create client portal logins from the `clients` table.
//
// SETUP (one-time):
//   1. cd scripts
//   2. npm init -y
//   3. npm install @supabase/supabase-js csv-parse
//
// EXPORT THE CLIENT LIST:
//   In Supabase Studio -> Table Editor -> clients table -> export/download
//   as CSV. Save it as scripts/clients.csv (needs at least the columns:
//   id, company_name, email).
//
// RUN:
//   Set two environment variables first (find both in Supabase ->
//   Project Settings -> API):
//     SUPABASE_URL              e.g. https://vqbchnbjzqfzfkdoqhhf.supabase.co
//     SUPABASE_SERVICE_ROLE_KEY the "service_role" secret key (NOT the anon key)
//
//   Windows PowerShell:
//     $env:SUPABASE_URL="https://xxxx.supabase.co"
//     $env:SUPABASE_SERVICE_ROLE_KEY="eyJ...."
//     node create-client-logins.js
//
// OUTPUT:
//   Prints progress to the console and writes
//   scripts/client-logins-output.csv with columns:
//   company,email,password,status
//   That file is what you send to the business owner. It contains live
//   passwords in plain text — delete it once you've distributed the
//   logins, and don't commit it to git.
// ============================================================

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { parse } = require('csv-parse/sync');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables. See the comment at the top of this file.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function generatePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%';
  const all = upper + lower + digits + symbols;

  const pwd = [
    upper[Math.floor(Math.random() * upper.length)],
    lower[Math.floor(Math.random() * lower.length)],
    digits[Math.floor(Math.random() * digits.length)],
    symbols[Math.floor(Math.random() * symbols.length)],
  ];
  for (let i = pwd.length; i < 12; i++) {
    pwd.push(all[Math.floor(Math.random() * all.length)]);
  }
  for (let i = pwd.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pwd[i], pwd[j]] = [pwd[j], pwd[i]];
  }
  return pwd.join('');
}

async function main() {
  const csvPath = path.join(__dirname, 'clients.csv');
  if (!fs.existsSync(csvPath)) {
    console.error('scripts/clients.csv not found. Export the clients table from Supabase and save it there first.');
    process.exit(1);
  }

  const rows = parse(fs.readFileSync(csvPath, 'utf8'), { columns: true, skip_empty_lines: true });
  const results = [];

  // Build a map of already-existing auth users (email -> id), so re-running
  // this script after a partial failure doesn't try to recreate accounts
  // that were already created in a previous run.
  console.log('Checking for existing accounts...');
  const existingByEmail = new Map();
  {
    let page = 1;
    while (true) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
      if (error) { console.error('Could not list existing users:', error.message); break; }
      for (const u of data.users) existingByEmail.set(u.email.toLowerCase(), u.id);
      if (data.users.length < 200) break;
      page++;
    }
  }
  console.log(`Found ${existingByEmail.size} existing account(s).\n`);

  const resetPasswordsThisRun = new Map(); // email -> password, so duplicate-email rows in one run share the same shown password

  for (const row of rows) {
    const clientId = row.id;
    const companyName = row.company_name || '(no name)';
    const email = row.email;

    if (!email) {
      console.warn(`Skipping "${companyName}" (id: ${clientId}) - no email address on file.`);
      results.push({ company: companyName, email: '', password: '', status: 'SKIPPED - no email' });
      continue;
    }

    const emailKey = email.toLowerCase();
    const existingId = existingByEmail.get(emailKey);
    let userId, password;

    if (existingId) {
      userId = existingId;
      if (resetPasswordsThisRun.has(emailKey)) {
        password = resetPasswordsThisRun.get(emailKey);
        console.log(`Account already exists for ${email}, reusing this run's reset password...`);
      } else {
        password = generatePassword();
        const { error: resetError } = await supabase.auth.admin.updateUserById(existingId, { password });
        if (resetError) {
          console.error(`Password reset FAILED for ${email}: ${resetError.message}`);
          results.push({ company: companyName, email, password: '', status: `ERROR resetting password: ${resetError.message}` });
          continue;
        }
        resetPasswordsThisRun.set(emailKey, password);
        console.log(`Account already existed for ${email}, password reset to a new one.`);
      }
    } else {
      password = generatePassword();
      const { data: userData, error: createError } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { role: 'client', client_id: clientId }
      });

      if (createError) {
        console.error(`FAILED for ${email}: ${createError.message}`);
        results.push({ company: companyName, email, password: '', status: `ERROR: ${createError.message}` });
        continue;
      }

      userId = userData.user.id;
      existingByEmail.set(emailKey, userId);
      resetPasswordsThisRun.set(emailKey, password);
    }

    const { error: profileError } = await supabase
      .from('profiles')
      .upsert({ id: userId, email, role: 'client', client_id: clientId }, { onConflict: 'id' });

    if (profileError) {
      console.error(`Profile sync FAILED for ${email}: ${profileError.message}`);
      results.push({ company: companyName, email, password, status: `Created, but profile sync failed: ${profileError.message}` });
      continue;
    }

    console.log(`OK: ${companyName} <${email}>`);
    results.push({ company: companyName, email, password, status: 'OK' });
  }

  const outPath = path.join(__dirname, 'client-logins-output.csv');
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const header = 'company,email,password,status\n';
  const lines = results.map(r => [r.company, r.email, r.password, r.status].map(esc).join(',')).join('\n');
  fs.writeFileSync(outPath, header + lines);

  const ok = results.filter(r => r.status === 'OK').length;
  console.log(`\nDone. ${ok}/${results.length} logins created successfully.`);
  console.log(`Full list written to ${outPath}`);
}

main();
