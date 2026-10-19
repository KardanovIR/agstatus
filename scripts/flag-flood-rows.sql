-- Flag the rows a server older than 1.6.2 wrote past the bounds 1.6.2 holds.
--
-- Flag-only: every change is `UPDATE … SET deleted_at = <now, epoch ms>
-- WHERE deleted_at IS NULL`. Nothing is removed, and every row this script
-- flags carries the same deleted_at, so the run can be listed (or undone)
-- afterwards by that one value.
--
-- Run it with psql against the board's database, on a server already running
-- 1.6.2 or later, in this order:
--
--   psql … -X -v mode=diagnose -f scripts/flag-flood-rows.sql   read only
--   psql … -X -v mode=dryrun   -f scripts/flag-flood-rows.sql   flags, checks, ROLLBACK
--   psql … -X -v mode=commit   -f scripts/flag-flood-rows.sql   flags, checks, COMMIT
--
-- With no mode it is a dry run; only mode=commit commits. The command lines
-- for the bundled docker-compose Postgres, agstatus.online included, are in
-- docs/self-hosting.md ("Flagging rows written before 1.6.2's bounds").
--
-- Optional: -v aged=flag also flags rows that are only past their retention
-- (see AGED below); the default, aged=leave, reports them and leaves them.
-- -v now_ms=<epoch ms> pins the instant the run is computed for (tests use
-- it); the default is the database clock when the run starts.
--
-- WHAT IS FLAGGED
--
-- Only rows that 1.6.2's Store.init() (src/store.ts) does not load at this
-- instant, whichever way Postgres breaks a tie, and that no later load can
-- reach either unless that same row is written again, which un-flags it the
-- way it always has. Removing them changes nothing a restart loads, so the
-- board shows exactly what it showed. The running server is not affected at
-- all: memory is authoritative and it never re-reads the tables.
--
-- One caveat, on boards past 5000 project days only. Where the 5000th place
-- falls inside a tie (rows of one report that share a day), Postgres picks
-- which of the tied rows fill the last places from the rows it is handed, and
-- flagging the rows behind the tie can change that pick. It never changes how
-- many are loaded, or any row outside the tie, and the pick can move on its
-- own whenever that board's rows change.
--
--   usage_project_days
--     after_window   day after tomorrow (UTC). 1.6.2 refuses these at write.
--                    The one category a later restart could otherwise have
--                    loaded, the day its date arrives, as tokens spent on a
--                    day nobody had reached when they were reported.
--     before_window  day before today − 90. 1.6.2's pruneProjectDays runs
--                    this same UPDATE per board on its first report after a
--                    day ages out; this does it for every board at once.
--     over_cap       in the window, but 5000 or more rows of the board rank
--                    strictly ahead of it (day DESC, updated_at DESC): RANK()
--                    past the cap, so ROW_NUMBER() can never reach 5000.
--     not_a_day      in the window but not a calendar day (2026-09-31). Only
--                    on boards where no row is cut at the cap: there, a
--                    non-day still holds one of the 5000 places, and flagging
--                    it would let a restart load a row it does not load now.
--   usage_session_totals
--     over_cap       received in the last 7 days, past rank 550 (500 plus a
--                    board of live cards).
--   usage_limits
--     over_cap       reported in the last 24 hours, past rank 8 (the source cap).
--   usage_history
--     series_over_cap  points of a series past the 48 heard from most recently.
--                    Only on boards that have never reported under more than
--                    8 sources. Elsewhere a board's source cap can leave room
--                    for such a series to record again, and a restart would
--                    then load its older points too.
--
-- REPORTED, NOT FLAGGED
--
--   not_a_day_held, series_over_cap_held   the two cases excluded above.
--   Rows hidden only by the source cap (8 per board): which 8 a restart keeps
--   depends on the order Postgres returns rows in, across four queries, one
--   of them unordered. There is no fixed set to match, so none is flagged.
--   Devices, sessions, session events and workspaces: load() reads every
--   live row of them, so nothing there is unloaded. Their counts are shown,
--   and the device tokens past 100 in 90 days are flagged already.
--   (load() also skips a usage_limits row that is not JSON. No server
--   version writes one, so the script does not look for them.)
--
-- AGED (left unless -v aged=flag)
--
--   usage_session_totals older than 7 days, usage_limits older than 24 hours,
--   usage_history older than 90 days, and points of a series past its newest
--   2000. No load reads them again, but they are ordinary retention, not
--   anything a bound refused, and the server leaves most of them as they are.
--
-- The run is one REPEATABLE READ transaction. The dry run and the commit run
-- first take SHARE ROW EXCLUSIVE on the four usage tables: reads go on, and
-- the server's writes wait until the transaction ends, a few seconds. They
-- queue in its memory, so the board stays live and nothing is lost. If a
-- write already holds a table, lock_timeout gives up after 10 s, nothing is
-- changed, and the run can simply be repeated. Before it ends, the dry run
-- and the commit run check that every planned row was flagged, that the rows
-- a restart loads are the same set as before, and that a second pass would
-- flag nothing. Any failure stops psql, and nothing is committed.
--
-- There is no DELETE, TRUNCATE or DROP in this file. It creates only
-- temporary tables and views, which go when the psql session ends.

\set ON_ERROR_STOP on
\set QUIET on
\pset pager off
\pset footer off

\if :{?mode}
\else
  \set mode dryrun
\endif
\if :{?aged}
\else
  \set aged leave
\endif
\if :{?now_ms}
\else
  SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms \gset
\endif

-- A wrong value stops the run here. The cast fails on purpose, so that the
-- error psql prints is the message itself.
SELECT CASE WHEN :'mode' IN ('diagnose', 'dryrun', 'commit') THEN 0
            ELSE ('mode must be diagnose, dryrun or commit, not ' || :'mode')::int END AS mode_ok \gset
SELECT CASE WHEN :'aged' IN ('leave', 'flag') THEN 0
            ELSE ('aged must be leave or flag, not ' || :'aged')::int END AS aged_ok \gset
SELECT CASE WHEN :'now_ms' ~ '^[0-9]{12,14}$' THEN 0
            ELSE ('now_ms must be epoch milliseconds, not ' || :'now_ms')::int END AS now_ok \gset
SELECT :'mode' = 'diagnose' AS is_diagnose, :'mode' = 'commit' AS is_commit \gset

BEGIN ISOLATION LEVEL REPEATABLE READ;
-- No statement here should take more than a second or two; this bounds how
-- long the lock below can hold the server's writes if one does.
SET LOCAL statement_timeout = '60s';
-- Room to hash the comparisons in the post-check instead of sorting them.
SET LOCAL work_mem = '64MB';
\if :is_diagnose
\else
  -- Before the first query, so that the snapshot is taken with writers held
  -- off and what is planned is exactly what is flagged.
  SET LOCAL lock_timeout = '10s';
  LOCK TABLE usage_project_days, usage_session_totals, usage_limits, usage_history
    IN SHARE ROW EXCLUSIVE MODE;
\endif

-- ---------------------------------------------------------------------------
-- The instant and the bounds, each as 1.6.2 computes it (src/store.ts):
-- projectDayWindow(now), SESSION_TOTAL_TTL_MS, USAGE_TTL_MS, MAX_HISTORY_DAYS,
-- DEVICE_RETIRED_WINDOW_MS and the per-workspace caps. Days are UTC.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE flag_params AS
SELECT now_ms,
       to_char(to_timestamp((now_ms - 90 * day_ms) / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS oldest_day,
       to_char(to_timestamp((now_ms + day_ms) / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS newest_day,
       now_ms - 7 * day_ms AS totals_since,
       now_ms - day_ms AS limits_since,
       now_ms - 90 * day_ms AS history_since,
       now_ms - 90 * day_ms AS devices_since,
       5000 AS max_project_days,
       550 AS max_session_totals,
       8 AS max_sources,
       48 AS max_series,
       2000 AS max_points,
       100 AS max_device_tokens,
       10 AS max_devices,
       50 AS max_sessions,
       100 AS max_events,
       :'aged' = 'flag' AS flag_aged
FROM (SELECT :now_ms::bigint AS now_ms, 86400000::bigint AS day_ms) t;

-- What happens to each fate. "kept" is every row a restart loads, or may load
-- when it ties at a cap; nothing kept is ever flagged.
CREATE TEMP TABLE flag_fates (tbl text, fate text, flagged boolean, meaning text);
INSERT INTO flag_fates
SELECT f.tbl, f.fate, f.flagged OR (f.aged AND p.flag_aged), f.meaning
FROM flag_params p, (VALUES
  ('usage_project_days',   'kept',                 false, false, 'loaded at restart (or tied at the cap)'),
  ('usage_project_days',   'after_window',         true,  false, 'day after tomorrow, UTC'),
  ('usage_project_days',   'before_window',        true,  false, 'day before today - 90'),
  ('usage_project_days',   'over_cap',             true,  false, 'past 5000 per board'),
  ('usage_project_days',   'not_a_day',            true,  false, 'not a calendar day'),
  ('usage_project_days',   'not_a_day_held',       false, false, 'not a calendar day, board at the cap: left'),
  ('usage_session_totals', 'kept',                 false, false, 'loaded at restart (or tied at the cap)'),
  ('usage_session_totals', 'over_cap',             true,  false, 'past 550 per board'),
  ('usage_session_totals', 'aged',                 false, true,  'older than 7 days'),
  ('usage_limits',         'kept',                 false, false, 'loaded at restart (or tied at the cap)'),
  ('usage_limits',         'over_cap',             true,  false, 'past 8 per board'),
  ('usage_limits',         'aged',                 false, true,  'older than 24 hours'),
  ('usage_history',        'kept',                 false, false, 'loaded at restart'),
  ('usage_history',        'series_over_cap',      true,  false, 'series past 48 per board'),
  ('usage_history',        'series_over_cap_held', false, false, 'series past 48, board over 8 sources: left'),
  ('usage_history',        'points_over_cap',      false, true,  'past a series'' newest 2000'),
  ('usage_history',        'aged',                 false, true,  'older than 90 days')
) AS f (tbl, fate, flagged, aged, meaning);

-- ---------------------------------------------------------------------------
-- Every live row of the four usage tables, with its fate. These views read
-- the tables as they are now; the plan below is a snapshot of them taken
-- before anything is flagged, and the post-check reads them again after.
-- Comparisons on text use the database's collation, as load() does.
-- ---------------------------------------------------------------------------

-- Store.init(): `day >= oldest AND day <= newest`, ROW_NUMBER() over
-- (day DESC, updated_at DESC) <= 5000 per board, then isCalendarDay(day).
CREATE TEMP VIEW flag_class_project_days AS
WITH p AS (SELECT * FROM flag_params),
live AS (
  SELECT d.workspace_id, d.source, d.project, d.day, d.updated_at,
         CASE WHEN d.day > p.newest_day THEN 'after_window'
              WHEN d.day < p.oldest_day THEN 'before_window' END AS outside,
         -- isCalendarDay(): the string Date.parse(`${day}T00:00:00Z`) gives
         -- back unchanged, which is a proleptic Gregorian YYYY-MM-DD. A CASE,
         -- so the casts only ever see digits.
         CASE WHEN d.day !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN false
              WHEN substr(d.day, 6, 2)::int NOT BETWEEN 1 AND 12 THEN false
              ELSE substr(d.day, 9, 2)::int BETWEEN 1 AND
                   CASE substr(d.day, 6, 2)::int
                     WHEN 2 THEN CASE WHEN (substr(d.day, 1, 4)::int % 4 = 0 AND substr(d.day, 1, 4)::int % 100 <> 0)
                                           OR substr(d.day, 1, 4)::int % 400 = 0 THEN 29 ELSE 28 END
                     WHEN 4 THEN 30 WHEN 6 THEN 30 WHEN 9 THEN 30 WHEN 11 THEN 30
                     ELSE 31 END
         END AS is_day
  FROM usage_project_days d CROSS JOIN p
  WHERE d.deleted_at IS NULL
),
win AS (
  SELECT l.*, RANK() OVER (PARTITION BY l.workspace_id ORDER BY l.day DESC, l.updated_at DESC) AS rnk
  FROM live l
  WHERE l.outside IS NULL
),
board AS (
  -- Rows ranked within the cap. More than the cap means a tie straddles it,
  -- and which of the tied rows a restart loads is Postgres's choice.
  SELECT w.workspace_id, count(*) FILTER (WHERE w.rnk <= p.max_project_days) AS within_cap
  FROM win w CROSS JOIN p
  GROUP BY w.workspace_id
)
SELECT l.workspace_id, l.source, l.project, l.day, l.updated_at, l.is_day, l.outside AS fate
FROM live l
WHERE l.outside IS NOT NULL
UNION ALL
SELECT w.workspace_id, w.source, w.project, w.day, w.updated_at, w.is_day,
       CASE WHEN w.rnk > p.max_project_days THEN 'over_cap'
            WHEN NOT w.is_day AND b.within_cap <= p.max_project_days THEN 'not_a_day'
            WHEN NOT w.is_day THEN 'not_a_day_held'
            ELSE 'kept' END
FROM win w JOIN board b USING (workspace_id) CROSS JOIN p;

-- Store.init(): updated_at within SESSION_TOTAL_TTL_MS, ROW_NUMBER() over
-- updated_at DESC <= MAX_SESSION_TOTALS_WITH_LIVE_CARDS per board.
CREATE TEMP VIEW flag_class_session_totals AS
WITH p AS (SELECT * FROM flag_params),
live AS (
  SELECT t.workspace_id, t.source, t.session_id, t.updated_at, t.updated_at >= p.totals_since AS fresh
  FROM usage_session_totals t CROSS JOIN p
  WHERE t.deleted_at IS NULL
),
ranked AS (
  SELECT l.*, RANK() OVER (PARTITION BY l.workspace_id ORDER BY l.updated_at DESC) AS rnk
  FROM live l
  WHERE l.fresh
)
SELECT workspace_id, source, session_id, updated_at, 'aged' AS fate FROM live WHERE NOT fresh
UNION ALL
SELECT r.workspace_id, r.source, r.session_id, r.updated_at,
       CASE WHEN r.rnk > p.max_session_totals THEN 'over_cap' ELSE 'kept' END
FROM ranked r CROSS JOIN p;

-- Store.init(): updated_at within USAGE_TTL_MS, ROW_NUMBER() over
-- updated_at DESC <= MAX_USAGE_SOURCES_PER_WORKSPACE per board.
CREATE TEMP VIEW flag_class_usage_limits AS
WITH p AS (SELECT * FROM flag_params),
live AS (
  SELECT u.workspace_id, u.source, u.updated_at, u.updated_at >= p.limits_since AS fresh
  FROM usage_limits u CROSS JOIN p
  WHERE u.deleted_at IS NULL
),
ranked AS (
  SELECT l.*, RANK() OVER (PARTITION BY l.workspace_id ORDER BY l.updated_at DESC) AS rnk
  FROM live l
  WHERE l.fresh
)
SELECT workspace_id, source, updated_at, 'aged' AS fate FROM live WHERE NOT fresh
UNION ALL
SELECT r.workspace_id, r.source, r.updated_at,
       CASE WHEN r.rnk > p.max_sources THEN 'over_cap' ELSE 'kept' END
FROM ranked r CROSS JOIN p;

-- Every source a board has ever reported under, flagged rows included.
CREATE TEMP VIEW flag_sources_ever AS
SELECT workspace_id, count(DISTINCT source) AS sources
FROM (SELECT workspace_id, source FROM usage_limits
      UNION ALL SELECT workspace_id, source FROM usage_history
      UNION ALL SELECT workspace_id, source FROM usage_project_days
      UNION ALL SELECT workspace_id, source FROM usage_session_totals) s
GROUP BY workspace_id;

-- Store.init(): at within MAX_HISTORY_DAYS; per series the newest
-- MAX_USAGE_POINTS by at; per board the MAX_USAGE_SERIES_PER_WORKSPACE series
-- by DENSE_RANK() over (newest DESC, source, window_id). (source, window_id)
-- is unique within a board, so that rank has no ties, and `at` is unique
-- within a series (it is in the primary key), so neither does the point rank.
CREATE TEMP VIEW flag_class_usage_history AS
WITH p AS (SELECT * FROM flag_params),
live AS (
  SELECT h.workspace_id, h.source, h.window_id, h.at, h.at >= p.history_since AS fresh
  FROM usage_history h CROSS JOIN p
  WHERE h.deleted_at IS NULL
),
pts AS (
  SELECT l.workspace_id, l.source, l.window_id, l.at,
         ROW_NUMBER() OVER (PARTITION BY l.workspace_id, l.source, l.window_id ORDER BY l.at DESC) AS point_rank,
         MAX(l.at) OVER (PARTITION BY l.workspace_id, l.source, l.window_id) AS newest
  FROM live l
  WHERE l.fresh
),
series AS (
  SELECT DISTINCT q.workspace_id, q.source, q.window_id, q.series_rank
  FROM (
    SELECT s.workspace_id, s.source, s.window_id,
           DENSE_RANK() OVER (PARTITION BY s.workspace_id ORDER BY s.newest DESC, s.source, s.window_id) AS series_rank
    FROM pts s CROSS JOIN p
    WHERE s.point_rank <= p.max_points
  ) q
)
SELECT workspace_id, source, window_id, at, 'aged' AS fate FROM live WHERE NOT fresh
UNION ALL
SELECT pt.workspace_id, pt.source, pt.window_id, pt.at,
       CASE WHEN s.series_rank > p.max_series AND coalesce(e.sources, 0) <= p.max_sources THEN 'series_over_cap'
            WHEN s.series_rank > p.max_series THEN 'series_over_cap_held'
            WHEN pt.point_rank > p.max_points THEN 'points_over_cap'
            ELSE 'kept' END
FROM pts pt
JOIN series s USING (workspace_id, source, window_id)
LEFT JOIN flag_sources_ever e USING (workspace_id)
CROSS JOIN p;

-- The plan: one snapshot of every view above, before anything changes.
CREATE TEMP TABLE flag_pd AS SELECT * FROM flag_class_project_days;
CREATE TEMP TABLE flag_st AS SELECT * FROM flag_class_session_totals;
CREATE TEMP TABLE flag_ul AS SELECT * FROM flag_class_usage_limits;
CREATE TEMP TABLE flag_uh AS SELECT * FROM flag_class_usage_history;
-- Autovacuum never analyzes temporary tables; without statistics the joins
-- below against the real tables plan as nested loops.
ANALYZE flag_pd, flag_st, flag_ul, flag_uh;

CREATE TEMP TABLE flag_totals_before AS
SELECT 'workspaces' AS tbl, count(*) FILTER (WHERE deleted_at IS NULL) AS live, count(*) FILTER (WHERE deleted_at IS NOT NULL) AS flagged FROM workspaces
UNION ALL SELECT 'sessions', count(*) FILTER (WHERE deleted_at IS NULL), count(*) FILTER (WHERE deleted_at IS NOT NULL) FROM sessions
UNION ALL SELECT 'session_events', count(*) FILTER (WHERE deleted_at IS NULL), count(*) FILTER (WHERE deleted_at IS NOT NULL) FROM session_events
UNION ALL SELECT 'devices', count(*) FILTER (WHERE deleted_at IS NULL), count(*) FILTER (WHERE deleted_at IS NOT NULL) FROM devices
UNION ALL SELECT 'usage_limits', count(*) FILTER (WHERE deleted_at IS NULL), count(*) FILTER (WHERE deleted_at IS NOT NULL) FROM usage_limits
UNION ALL SELECT 'usage_history', count(*) FILTER (WHERE deleted_at IS NULL), count(*) FILTER (WHERE deleted_at IS NOT NULL) FROM usage_history
UNION ALL SELECT 'usage_project_days', count(*) FILTER (WHERE deleted_at IS NULL), count(*) FILTER (WHERE deleted_at IS NOT NULL) FROM usage_project_days
UNION ALL SELECT 'usage_session_totals', count(*) FILTER (WHERE deleted_at IS NULL), count(*) FILTER (WHERE deleted_at IS NOT NULL) FROM usage_session_totals;

\if :is_diagnose
  -- Everything from here on only reads. Postgres refuses any write to a
  -- real table for the rest of the transaction.
  SET TRANSACTION READ ONLY;
\endif

-- ---------------------------------------------------------------------------
-- (a) Diagnostics. Board ids are shown as their first 12 characters; no
-- project name, session id, source name or token is printed.
-- ---------------------------------------------------------------------------
\echo
\echo '== Run'
SELECT :'mode' AS mode, :'aged' AS aged, p.now_ms,
       to_char(to_timestamp(p.now_ms / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') || ' UTC' AS now_utc,
       p.oldest_day || ' .. ' || p.newest_day AS project_day_window
FROM flag_params p;

\echo
\echo '== Rows per table'
SELECT tbl AS "table", live, flagged FROM flag_totals_before;

\echo
\echo '== Boards: how many, and the 20 with the most live usage rows (state "none": rows with no workspaces row)'
SELECT count(*) FILTER (WHERE deleted_at IS NULL) AS live_boards,
       count(*) FILTER (WHERE deleted_at IS NOT NULL) AS deleted_boards
FROM workspaces;
WITH ws AS (
  SELECT id, CASE WHEN deleted_at IS NULL THEN 'live' ELSE 'deleted' END AS state FROM workspaces
),
counts AS (
  SELECT workspace_id, 'sessions' AS tbl, count(*) AS n FROM sessions WHERE deleted_at IS NULL GROUP BY 1
  UNION ALL SELECT workspace_id, 'events', count(*) FROM session_events WHERE deleted_at IS NULL GROUP BY 1
  UNION ALL SELECT workspace_id, 'devices', count(*) FROM devices WHERE deleted_at IS NULL GROUP BY 1
  UNION ALL SELECT workspace_id, 'limits', count(*) FROM usage_limits WHERE deleted_at IS NULL GROUP BY 1
  UNION ALL SELECT workspace_id, 'history', count(*) FROM usage_history WHERE deleted_at IS NULL GROUP BY 1
  UNION ALL SELECT workspace_id, 'project_days', count(*) FROM usage_project_days WHERE deleted_at IS NULL GROUP BY 1
  UNION ALL SELECT workspace_id, 'session_totals', count(*) FROM usage_session_totals WHERE deleted_at IS NULL GROUP BY 1
)
SELECT left(c.workspace_id, 12) AS board, coalesce(ws.state, 'none') AS state,
       coalesce(sum(n) FILTER (WHERE tbl = 'sessions'), 0) AS sessions,
       coalesce(sum(n) FILTER (WHERE tbl = 'events'), 0) AS events,
       coalesce(sum(n) FILTER (WHERE tbl = 'devices'), 0) AS devices,
       coalesce(sum(n) FILTER (WHERE tbl = 'limits'), 0) AS limits,
       coalesce(sum(n) FILTER (WHERE tbl = 'history'), 0) AS history,
       coalesce(sum(n) FILTER (WHERE tbl = 'project_days'), 0) AS project_days,
       coalesce(sum(n) FILTER (WHERE tbl = 'session_totals'), 0) AS session_totals
FROM counts c LEFT JOIN ws ON ws.id = c.workspace_id
GROUP BY c.workspace_id, ws.state
ORDER BY coalesce(sum(n) FILTER (WHERE tbl IN ('limits', 'history', 'project_days', 'session_totals')), 0) DESC,
         c.workspace_id
LIMIT 20;

\echo
\echo '== Project days outside the window, or not a calendar day (by board)'
SELECT left(workspace_id, 12) AS board,
       count(*) FILTER (WHERE fate = 'before_window') AS before_window,
       count(*) FILTER (WHERE fate = 'after_window') AS after_window,
       count(*) FILTER (WHERE NOT is_day) AS not_a_day,
       min(day) AS earliest, max(day) AS latest
FROM flag_pd
WHERE fate IN ('before_window', 'after_window') OR NOT is_day
GROUP BY workspace_id
ORDER BY count(*) DESC, workspace_id
LIMIT 20;

\echo
\echo '== Boards over each 1.6.2 bound (live rows)'
WITH p AS (SELECT * FROM flag_params),
pd AS (SELECT workspace_id, count(*) AS n FROM flag_pd WHERE fate NOT IN ('before_window', 'after_window') GROUP BY 1),
st AS (SELECT workspace_id, count(*) AS n FROM flag_st WHERE fate <> 'aged' GROUP BY 1),
ul AS (SELECT workspace_id, count(*) AS n FROM flag_ul WHERE fate <> 'aged' GROUP BY 1),
uh_series AS (SELECT workspace_id, count(*) AS n FROM (SELECT DISTINCT workspace_id, source, window_id FROM flag_uh WHERE fate <> 'aged') s GROUP BY 1),
uh_points AS (SELECT workspace_id, source, window_id, count(*) AS n FROM flag_uh WHERE fate <> 'aged' GROUP BY 1, 2, 3),
src_live AS (
  SELECT workspace_id, count(DISTINCT source) AS n FROM (
    SELECT workspace_id, source FROM usage_limits WHERE deleted_at IS NULL
    UNION ALL SELECT workspace_id, source FROM usage_history WHERE deleted_at IS NULL
    UNION ALL SELECT workspace_id, source FROM usage_project_days WHERE deleted_at IS NULL
    UNION ALL SELECT workspace_id, source FROM usage_session_totals WHERE deleted_at IS NULL) s
  GROUP BY 1),
dev AS (
  SELECT d.workspace_id,
         count(*) FILTER (WHERE d.deleted_at IS NULL) AS live,
         count(*) FILTER (WHERE d.deleted_at IS NULL OR d.deleted_at >= p.devices_since) AS counted
  FROM devices d CROSS JOIN p GROUP BY 1),
ses AS (SELECT workspace_id, count(*) AS n FROM sessions WHERE deleted_at IS NULL GROUP BY 1),
ev AS (SELECT workspace_id, session_id, count(*) AS n FROM session_events WHERE deleted_at IS NULL GROUP BY 1, 2),
bounds AS (
  SELECT 'project days in the window' AS bound, p.max_project_days AS cap, n FROM pd, p
  UNION ALL SELECT 'session totals, last 7 days', p.max_session_totals, n FROM st, p
  UNION ALL SELECT 'usage limits, last 24 hours', p.max_sources, n FROM ul, p
  UNION ALL SELECT 'history series, last 90 days', p.max_series, n FROM uh_series, p
  UNION ALL SELECT 'points in one series (per series)', p.max_points, n FROM uh_points, p
  UNION ALL SELECT 'usage sources, live rows', p.max_sources, n FROM src_live, p
  UNION ALL SELECT 'usage sources, ever (flagged too)', p.max_sources, sources FROM flag_sources_ever, p
  UNION ALL SELECT 'live devices', p.max_devices, live FROM dev, p
  UNION ALL SELECT 'device tokens, live + flagged in 90 days', p.max_device_tokens, counted FROM dev, p
  UNION ALL SELECT 'live sessions (hosted cap)', p.max_sessions, n FROM ses, p
  UNION ALL SELECT 'live events in one session (per session)', p.max_events, n FROM ev, p
)
SELECT bound, cap, count(*) FILTER (WHERE n > cap) AS over, coalesce(max(n), 0) AS highest,
       coalesce(sum(n - cap) FILTER (WHERE n > cap), 0) AS rows_past_cap
FROM bounds
GROUP BY bound, cap
ORDER BY min(CASE bound
  WHEN 'project days in the window' THEN 1 WHEN 'session totals, last 7 days' THEN 2
  WHEN 'usage limits, last 24 hours' THEN 3 WHEN 'history series, last 90 days' THEN 4
  WHEN 'points in one series (per series)' THEN 5 WHEN 'usage sources, live rows' THEN 6
  WHEN 'usage sources, ever (flagged too)' THEN 7 WHEN 'live devices' THEN 8
  WHEN 'device tokens, live + flagged in 90 days' THEN 9 WHEN 'live sessions (hosted cap)' THEN 10
  ELSE 11 END);

\echo
\echo '== Boards over 8 usage sources (the source cap is reported, never flagged)'
WITH per_table AS (
  SELECT workspace_id, 'limits' AS tbl, count(DISTINCT source) AS n FROM usage_limits WHERE deleted_at IS NULL GROUP BY 1
  UNION ALL SELECT workspace_id, 'history', count(DISTINCT source) FROM usage_history WHERE deleted_at IS NULL GROUP BY 1
  UNION ALL SELECT workspace_id, 'project_days', count(DISTINCT source) FROM usage_project_days WHERE deleted_at IS NULL GROUP BY 1
  UNION ALL SELECT workspace_id, 'session_totals', count(DISTINCT source) FROM usage_session_totals WHERE deleted_at IS NULL GROUP BY 1
)
SELECT left(e.workspace_id, 12) AS board, e.sources AS sources_ever,
       coalesce(sum(n) FILTER (WHERE tbl = 'limits'), 0) AS in_limits,
       coalesce(sum(n) FILTER (WHERE tbl = 'history'), 0) AS in_history,
       coalesce(sum(n) FILTER (WHERE tbl = 'project_days'), 0) AS in_project_days,
       coalesce(sum(n) FILTER (WHERE tbl = 'session_totals'), 0) AS in_session_totals
FROM flag_sources_ever e CROSS JOIN flag_params p
LEFT JOIN per_table t USING (workspace_id)
WHERE e.sources > p.max_sources
GROUP BY e.workspace_id, e.sources
ORDER BY e.sources DESC, e.workspace_id
LIMIT 20;

\echo
\echo '== Boards over 100 device tokens in 90 days (reported only: those rows are flagged already)'
SELECT left(d.workspace_id, 12) AS board,
       count(*) FILTER (WHERE d.deleted_at IS NULL) AS live,
       count(*) FILTER (WHERE d.deleted_at >= p.devices_since) AS flagged_in_90_days,
       count(*) FILTER (WHERE d.deleted_at < p.devices_since) AS flagged_earlier
FROM devices d CROSS JOIN flag_params p
GROUP BY d.workspace_id, p.devices_since, p.max_device_tokens
HAVING count(*) FILTER (WHERE d.deleted_at IS NULL OR d.deleted_at >= p.devices_since) > p.max_device_tokens
ORDER BY count(*) DESC, d.workspace_id
LIMIT 20;

\echo
\echo '== The plan: every live usage row by fate'
WITH plan AS (
  SELECT 'usage_project_days' AS tbl, workspace_id, fate FROM flag_pd
  UNION ALL SELECT 'usage_session_totals', workspace_id, fate FROM flag_st
  UNION ALL SELECT 'usage_limits', workspace_id, fate FROM flag_ul
  UNION ALL SELECT 'usage_history', workspace_id, fate FROM flag_uh
)
SELECT f.tbl AS "table", f.fate, CASE WHEN f.flagged THEN 'FLAG' ELSE '-' END AS action,
       count(pl.fate) AS "rows", count(DISTINCT pl.workspace_id) AS boards, f.meaning
FROM flag_fates f
LEFT JOIN plan pl ON pl.tbl = f.tbl AND pl.fate = f.fate
GROUP BY f.tbl, f.fate, f.flagged, f.meaning
ORDER BY CASE f.tbl WHEN 'usage_project_days' THEN 1 WHEN 'usage_session_totals' THEN 2
                    WHEN 'usage_limits' THEN 3 ELSE 4 END,
         f.fate = 'kept' DESC, f.flagged DESC, f.fate;

\echo
\echo '== Rows this run would flag, by board'
WITH plan AS (
  SELECT 'project_days' AS tbl, workspace_id FROM flag_pd JOIN flag_fates f ON f.tbl = 'usage_project_days' AND f.fate = flag_pd.fate AND f.flagged
  UNION ALL SELECT 'session_totals', workspace_id FROM flag_st JOIN flag_fates f ON f.tbl = 'usage_session_totals' AND f.fate = flag_st.fate AND f.flagged
  UNION ALL SELECT 'limits', workspace_id FROM flag_ul JOIN flag_fates f ON f.tbl = 'usage_limits' AND f.fate = flag_ul.fate AND f.flagged
  UNION ALL SELECT 'history', workspace_id FROM flag_uh JOIN flag_fates f ON f.tbl = 'usage_history' AND f.fate = flag_uh.fate AND f.flagged
)
SELECT left(workspace_id, 12) AS board,
       count(*) FILTER (WHERE tbl = 'project_days') AS project_days,
       count(*) FILTER (WHERE tbl = 'session_totals') AS session_totals,
       count(*) FILTER (WHERE tbl = 'limits') AS limits,
       count(*) FILTER (WHERE tbl = 'history') AS history
FROM plan
GROUP BY workspace_id
ORDER BY count(*) DESC, workspace_id
LIMIT 20;

\if :is_diagnose
  \echo
  \echo 'Diagnose only: nothing was written. Next: -v mode=dryrun'
  ROLLBACK;
  \quit
\endif

-- ---------------------------------------------------------------------------
-- (b) The flag step. Flag-only, from the plan, and only a row still exactly
-- as planned (live, same updated_at), so a run can never flag anything it
-- did not first report.
-- ---------------------------------------------------------------------------
\echo
\echo '== Flagging'
WITH done AS (
  UPDATE usage_project_days d SET deleted_at = p.now_ms
  FROM flag_pd f, flag_fates ff, flag_params p
  WHERE ff.tbl = 'usage_project_days' AND ff.fate = f.fate AND ff.flagged
    AND d.workspace_id = f.workspace_id AND d.source = f.source AND d.project = f.project AND d.day = f.day
    AND d.updated_at = f.updated_at AND d.deleted_at IS NULL
  RETURNING f.fate
)
SELECT 'usage_project_days' AS "table", fate, count(*) AS flagged FROM done GROUP BY fate ORDER BY fate;

WITH done AS (
  UPDATE usage_session_totals t SET deleted_at = p.now_ms
  FROM flag_st f, flag_fates ff, flag_params p
  WHERE ff.tbl = 'usage_session_totals' AND ff.fate = f.fate AND ff.flagged
    AND t.workspace_id = f.workspace_id AND t.source = f.source AND t.session_id = f.session_id
    AND t.updated_at = f.updated_at AND t.deleted_at IS NULL
  RETURNING f.fate
)
SELECT 'usage_session_totals' AS "table", fate, count(*) AS flagged FROM done GROUP BY fate ORDER BY fate;

WITH done AS (
  UPDATE usage_limits u SET deleted_at = p.now_ms
  FROM flag_ul f, flag_fates ff, flag_params p
  WHERE ff.tbl = 'usage_limits' AND ff.fate = f.fate AND ff.flagged
    AND u.workspace_id = f.workspace_id AND u.source = f.source
    AND u.updated_at = f.updated_at AND u.deleted_at IS NULL
  RETURNING f.fate
)
SELECT 'usage_limits' AS "table", fate, count(*) AS flagged FROM done GROUP BY fate ORDER BY fate;

WITH done AS (
  UPDATE usage_history h SET deleted_at = p.now_ms
  FROM flag_uh f, flag_fates ff, flag_params p
  WHERE ff.tbl = 'usage_history' AND ff.fate = f.fate AND ff.flagged
    AND h.workspace_id = f.workspace_id AND h.source = f.source AND h.window_id = f.window_id AND h.at = f.at
    AND h.deleted_at IS NULL
  RETURNING f.fate
)
SELECT 'usage_history' AS "table", fate, count(*) AS flagged FROM done GROUP BY fate ORDER BY fate;

-- ---------------------------------------------------------------------------
-- (c) Post-check, inside the transaction and before COMMIT. Any failure
-- raises, psql stops, and the transaction is rolled back.
-- ---------------------------------------------------------------------------
\echo
\echo '== Post-check'
-- The same views, read again now that the flags are in.
CREATE TEMP TABLE flag_pd_after AS SELECT * FROM flag_class_project_days;
CREATE TEMP TABLE flag_st_after AS SELECT * FROM flag_class_session_totals;
CREATE TEMP TABLE flag_ul_after AS SELECT * FROM flag_class_usage_limits;
CREATE TEMP TABLE flag_uh_after AS SELECT * FROM flag_class_usage_history;
ANALYZE flag_pd_after, flag_st_after, flag_ul_after, flag_uh_after;
DO $$
DECLARE
  planned bigint;
  marked bigint;
  drift bigint;
  again bigint;
BEGIN
  -- 1. Every planned row carries this run's flag. (The UPDATEs join the
  -- plan, so nothing outside it can have been touched.)
  SELECT count(*) INTO planned FROM (
    SELECT 1 FROM flag_pd f JOIN flag_fates ff ON ff.tbl = 'usage_project_days' AND ff.fate = f.fate AND ff.flagged
    UNION ALL SELECT 1 FROM flag_st f JOIN flag_fates ff ON ff.tbl = 'usage_session_totals' AND ff.fate = f.fate AND ff.flagged
    UNION ALL SELECT 1 FROM flag_ul f JOIN flag_fates ff ON ff.tbl = 'usage_limits' AND ff.fate = f.fate AND ff.flagged
    UNION ALL SELECT 1 FROM flag_uh f JOIN flag_fates ff ON ff.tbl = 'usage_history' AND ff.fate = f.fate AND ff.flagged
  ) x;
  SELECT (SELECT count(*) FROM usage_project_days d JOIN flag_pd f USING (workspace_id, source, project, day)
            JOIN flag_fates ff ON ff.tbl = 'usage_project_days' AND ff.fate = f.fate AND ff.flagged, flag_params p
          WHERE d.deleted_at = p.now_ms)
       + (SELECT count(*) FROM usage_session_totals t JOIN flag_st f USING (workspace_id, source, session_id)
            JOIN flag_fates ff ON ff.tbl = 'usage_session_totals' AND ff.fate = f.fate AND ff.flagged, flag_params p
          WHERE t.deleted_at = p.now_ms)
       + (SELECT count(*) FROM usage_limits u JOIN flag_ul f USING (workspace_id, source)
            JOIN flag_fates ff ON ff.tbl = 'usage_limits' AND ff.fate = f.fate AND ff.flagged, flag_params p
          WHERE u.deleted_at = p.now_ms)
       + (SELECT count(*) FROM usage_history h JOIN flag_uh f USING (workspace_id, source, window_id, at)
            JOIN flag_fates ff ON ff.tbl = 'usage_history' AND ff.fate = f.fate AND ff.flagged, flag_params p
          WHERE h.deleted_at = p.now_ms)
    INTO marked;
  IF marked <> planned THEN
    RAISE EXCEPTION 'post-check: % rows planned, % carry this run''s flag', planned, marked;
  END IF;

  -- 2. The rows a restart loads are the same set as before the flag step.
  SELECT (SELECT count(*) FROM (
            (SELECT workspace_id, source, project, day FROM flag_pd WHERE fate = 'kept'
             EXCEPT SELECT workspace_id, source, project, day FROM flag_pd_after WHERE fate = 'kept')
            UNION ALL
            (SELECT workspace_id, source, project, day FROM flag_pd_after WHERE fate = 'kept'
             EXCEPT SELECT workspace_id, source, project, day FROM flag_pd WHERE fate = 'kept')) x)
       + (SELECT count(*) FROM (
            (SELECT workspace_id, source, session_id FROM flag_st WHERE fate = 'kept'
             EXCEPT SELECT workspace_id, source, session_id FROM flag_st_after WHERE fate = 'kept')
            UNION ALL
            (SELECT workspace_id, source, session_id FROM flag_st_after WHERE fate = 'kept'
             EXCEPT SELECT workspace_id, source, session_id FROM flag_st WHERE fate = 'kept')) x)
       + (SELECT count(*) FROM (
            (SELECT workspace_id, source FROM flag_ul WHERE fate = 'kept'
             EXCEPT SELECT workspace_id, source FROM flag_ul_after WHERE fate = 'kept')
            UNION ALL
            (SELECT workspace_id, source FROM flag_ul_after WHERE fate = 'kept'
             EXCEPT SELECT workspace_id, source FROM flag_ul WHERE fate = 'kept')) x)
       + (SELECT count(*) FROM (
            (SELECT workspace_id, source, window_id, at FROM flag_uh WHERE fate = 'kept'
             EXCEPT SELECT workspace_id, source, window_id, at FROM flag_uh_after WHERE fate = 'kept')
            UNION ALL
            (SELECT workspace_id, source, window_id, at FROM flag_uh_after WHERE fate = 'kept'
             EXCEPT SELECT workspace_id, source, window_id, at FROM flag_uh WHERE fate = 'kept')) x)
    INTO drift;
  IF drift <> 0 THEN
    RAISE EXCEPTION 'post-check: the rows a restart loads changed (% differ)', drift;
  END IF;

  -- 3. A second pass, now, would flag nothing.
  SELECT (SELECT count(*) FROM flag_pd_after c JOIN flag_fates ff ON ff.tbl = 'usage_project_days' AND ff.fate = c.fate AND ff.flagged)
       + (SELECT count(*) FROM flag_st_after c JOIN flag_fates ff ON ff.tbl = 'usage_session_totals' AND ff.fate = c.fate AND ff.flagged)
       + (SELECT count(*) FROM flag_ul_after c JOIN flag_fates ff ON ff.tbl = 'usage_limits' AND ff.fate = c.fate AND ff.flagged)
       + (SELECT count(*) FROM flag_uh_after c JOIN flag_fates ff ON ff.tbl = 'usage_history' AND ff.fate = c.fate AND ff.flagged)
    INTO again;
  IF again <> 0 THEN
    RAISE EXCEPTION 'post-check: a second pass would flag % more rows', again;
  END IF;

  RAISE NOTICE 'post-check passed: % rows flagged, the rows a restart loads are unchanged, a second pass flags nothing', planned;
END $$;

WITH after AS (
  SELECT 'workspaces' AS tbl, count(*) FILTER (WHERE deleted_at IS NULL) AS live, count(*) FILTER (WHERE deleted_at IS NOT NULL) AS flagged FROM workspaces
  UNION ALL SELECT 'sessions', count(*) FILTER (WHERE deleted_at IS NULL), count(*) FILTER (WHERE deleted_at IS NOT NULL) FROM sessions
  UNION ALL SELECT 'session_events', count(*) FILTER (WHERE deleted_at IS NULL), count(*) FILTER (WHERE deleted_at IS NOT NULL) FROM session_events
  UNION ALL SELECT 'devices', count(*) FILTER (WHERE deleted_at IS NULL), count(*) FILTER (WHERE deleted_at IS NOT NULL) FROM devices
  UNION ALL SELECT 'usage_limits', count(*) FILTER (WHERE deleted_at IS NULL), count(*) FILTER (WHERE deleted_at IS NOT NULL) FROM usage_limits
  UNION ALL SELECT 'usage_history', count(*) FILTER (WHERE deleted_at IS NULL), count(*) FILTER (WHERE deleted_at IS NOT NULL) FROM usage_history
  UNION ALL SELECT 'usage_project_days', count(*) FILTER (WHERE deleted_at IS NULL), count(*) FILTER (WHERE deleted_at IS NOT NULL) FROM usage_project_days
  UNION ALL SELECT 'usage_session_totals', count(*) FILTER (WHERE deleted_at IS NULL), count(*) FILTER (WHERE deleted_at IS NOT NULL) FROM usage_session_totals
)
SELECT b.tbl AS "table", b.live AS live_before, a.live AS live_after, b.flagged AS flagged_before, a.flagged AS flagged_after
FROM flag_totals_before b JOIN after a USING (tbl);

\if :is_commit
  COMMIT;
  \echo
  SELECT format('Committed. %s rows flagged, each with deleted_at = %s.',
                (SELECT count(*) FROM (
                   SELECT fate, 'usage_project_days' AS tbl FROM flag_pd
                   UNION ALL SELECT fate, 'usage_session_totals' FROM flag_st
                   UNION ALL SELECT fate, 'usage_limits' FROM flag_ul
                   UNION ALL SELECT fate, 'usage_history' FROM flag_uh
                 ) plan JOIN flag_fates f ON f.tbl = plan.tbl AND f.fate = plan.fate AND f.flagged),
                now_ms) AS result
  FROM flag_params;
\else
  \echo
  \echo 'Dry run: rolled back, nothing was changed. To apply: -v mode=commit'
  ROLLBACK;
\endif
