-- 服務負責人改為複數（expand 階段）：新增 owner_discord_ids 並回填舊欄位。
-- 舊欄位 owner_discord_id 暫留：線上仍跑舊版程式，待新版部署後另以 migration 移除（contract 階段）。
-- 空陣列 = 未設定負責人（通知照發、不 tag）。元素格式與舊欄位相同：Discord snowflake 17–20 位數字。
alter table public.services
  add column owner_discord_ids text[] not null default '{}';

update public.services
  set owner_discord_ids = array[owner_discord_id]
  where owner_discord_id is not null;

-- CHECK 不能用子查詢，改以字串化後整體比對；array_position 擋 null 元素（array_to_string 會略過 null）。
alter table public.services
  add constraint services_owner_discord_ids_format check (
    cardinality(owner_discord_ids) <= 10
    and array_position(owner_discord_ids, null) is null
    and (
      cardinality(owner_discord_ids) = 0
      or (
        array_to_string(owner_discord_ids, ',') ~ '^[0-9]{17,20}(,[0-9]{17,20})*$'
        -- 擋單一元素內含逗號（{"a,b"}）冒充兩個 id
        and cardinality(string_to_array(array_to_string(owner_discord_ids, ','), ',')) = cardinality(owner_discord_ids)
      )
    )
  );
