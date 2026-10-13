-- 12/10/2026: lo usa solo el worker cocos-sync (service role) para leer la
-- clave de Matriz que el usuario cargo desde la app con guardar_credencial_matriz.
-- Revocado a anon/authenticated: ningun usuario puede leer una clave, ni la suya.
create or replace function public.leer_credencial_matriz(p_secret_name text)
returns text
language plpgsql
security definer
set search_path to 'vault', 'public'
as $$
declare v text;
begin
  if p_secret_name is null or p_secret_name !~ '^matriz:[0-9a-f-]{36}:[a-z0-9_]{2,30}(:[a-z0-9_-]{1,30})?$' then
    raise exception 'nombre de secreto inválido';
  end if;
  select decrypted_secret into v from vault.decrypted_secrets where name = p_secret_name;
  return v;
end $$;

revoke all on function public.leer_credencial_matriz(text) from public;
revoke all on function public.leer_credencial_matriz(text) from anon;
revoke all on function public.leer_credencial_matriz(text) from authenticated;
grant execute on function public.leer_credencial_matriz(text) to service_role;
