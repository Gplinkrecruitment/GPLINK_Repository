-- Atomic rate-limit counter (2026-07-30).
--
-- WHY: checkRateLimitWindow used to READ the counter, decide, then WRITE it back
-- as two separate PostgREST calls. That is a read-modify-write race: fire 200
-- login attempts at the same instant and all 200 read count=0, all pass the
-- check, and all write count=1 — so 200 attempts are recorded as ONE. The
-- effective limit was (limit x parallelism), not the limit. At a handful of
-- users nobody sends parallel requests; at 1000 concurrent doctors the app is
-- already serving that concurrency, so the limiter was becoming decorative
-- exactly as it started to matter.
--
-- This does the whole thing in ONE statement. `insert ... on conflict do update`
-- takes a row lock, so concurrent callers serialise and each one sees the real
-- count. Returns the post-increment count plus whether it is within the limit.
--
-- Sliding-window semantics are unchanged from the JS it replaces: a hit that
-- lands after windowStart + p_window_ms starts a fresh window at count 1.
-- The row is given a little slack past the window before it expires so the
-- counter is never dropped while it is still being consulted.

create or replace function public.rate_limit_hit(
  p_key text,
  p_max integer,
  p_window_ms bigint
)
returns jsonb
language plpgsql
as $$
declare
  v_now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  v_expires timestamptz := now() + make_interval(secs => (p_window_ms + 60000) / 1000.0);
  v_value jsonb;
begin
  insert into public.runtime_kv (key, value, expires_at)
  values (p_key, jsonb_build_object('windowStart', v_now_ms, 'count', 1), v_expires)
  on conflict (key) do update
    set value = case
          -- Previous window has elapsed (or the stored row is malformed) -> restart.
          when coalesce((runtime_kv.value ->> 'windowStart')::bigint, 0) <= v_now_ms - p_window_ms
            then jsonb_build_object('windowStart', v_now_ms, 'count', 1)
          else jsonb_build_object(
                 'windowStart', coalesce((runtime_kv.value ->> 'windowStart')::bigint, v_now_ms),
                 'count', coalesce((runtime_kv.value ->> 'count')::integer, 0) + 1
               )
        end,
        expires_at = v_expires
  returning value into v_value;

  return jsonb_build_object(
    'allowed', coalesce((v_value ->> 'count')::integer, 1) <= p_max,
    'count', coalesce((v_value ->> 'count')::integer, 1),
    'windowStart', coalesce((v_value ->> 'windowStart')::bigint, v_now_ms)
  );
end;
$$;

-- Only the service role reaches PostgREST here; keep it off the public roles.
revoke all on function public.rate_limit_hit(text, integer, bigint) from anon, authenticated;
