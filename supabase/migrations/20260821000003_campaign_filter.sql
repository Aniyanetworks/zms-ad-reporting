-- Some clients share one Meta ad account (e.g. Elite Local Pros runs campaigns for
-- both Hurley Construction and Austin Texas Construction). meta_campaign_filter is a
-- SQL ILIKE pattern applied at transform time so each client only ingests its own
-- campaigns. NULL = ingest every campaign in the account (the normal 1:1 case).
alter table clients add column meta_campaign_filter text;
