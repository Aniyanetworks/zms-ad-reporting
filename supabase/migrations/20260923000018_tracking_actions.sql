-- Tracking rollout (2026-09-23): two executable recommendation actions the dashboard
-- can perform itself after a person approves them.
--   fix_utm       swap an ad's creative for one on the same post + standard URL tags
--   create_pixel  create a Meta pixel/dataset on an ad account that has none
--   fix_tracking  turn on the ad-level Website events + Offline events toggles (tracking_specs)
-- Non-destructive: widens a check constraint only.
alter table recommendations drop constraint if exists recommendations_action_check;
alter table recommendations add constraint recommendations_action_check check (action in (
  'budget_change', 'pause', 'activate', 'refresh_creative', 'fix_signal', 'investigate',
  'fix_utm', 'create_pixel', 'fix_tracking'));
