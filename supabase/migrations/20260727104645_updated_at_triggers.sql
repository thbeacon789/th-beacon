-- 任何 UPDATE 自動 bump updated_at（services / issues 會被管線高頻更新）
create extension if not exists moddatetime with schema extensions;

create trigger services_set_updated_at
  before update on public.services
  for each row execute function extensions.moddatetime(updated_at);

create trigger issues_set_updated_at
  before update on public.issues
  for each row execute function extensions.moddatetime(updated_at);
