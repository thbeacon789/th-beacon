create table public.issue_comments (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references public.issues(id) on delete cascade,
  author text not null,
  body text not null check (char_length(body) between 1 and 2000),
  kind text not null check (kind in ('comment','resolve')),
  created_at timestamptz not null default now()
);
create index issue_comments_issue_created_idx on public.issue_comments (issue_id, created_at);
alter table public.issue_comments enable row level security;

create table public.security_finding_comments (
  id uuid primary key default gen_random_uuid(),
  finding_id uuid not null references public.security_findings(id) on delete cascade,
  author text not null,
  body text not null check (char_length(body) between 1 and 2000),
  kind text not null check (kind in ('comment','resolve')),
  created_at timestamptz not null default now()
);
create index security_finding_comments_finding_created_idx on public.security_finding_comments (finding_id, created_at);
alter table public.security_finding_comments enable row level security;
