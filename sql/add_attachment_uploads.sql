-- Tracks letter/document uploads via the Letter Uploader tool
-- One row per batch upload (not per employee)
create table if not exists attachment_uploads (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  client_id     uuid references clients(id) on delete set null,
  description   text,                    -- Attachment Description from Step 4
  classification text,                   -- e.g. General, IRP5
  total         int not null default 0,  -- total PDFs attempted
  uploaded      int not null default 0,  -- successful uploads
  failed        int not null default 0,  -- failed uploads
  employee_numbers text[]               -- array of emp numbers attempted
);

alter table attachment_uploads enable row level security;

-- Admins only (matches existing pattern from other tables)
create policy "Admins can do everything on attachment_uploads"
  on attachment_uploads for all
  using (
    (auth.jwt() -> 'user_metadata' ->> 'role') = 'admin'
  );
