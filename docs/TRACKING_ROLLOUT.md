# Tracking rollout — website events, offline events, standard UTMs

Goal (Carl, 2026-09-23): every current Meta client sends Meta the full signal —
website conversions (pixel + Conversions API), offline outcomes (booked
appointments and won jobs from GoHighLevel via CAPI) — and every website ad
carries the standard URL tags so the dashboard can attribute leads per ad set.

## What is automated, what is manual

| Piece | How | Who |
|---|---|---|
| Find gaps across all clients | Integrations page → **Propose tracking fixes** (admin). Reads each ad account live and writes `proposed` recommendations to the Actions queue (no duplicates while one is open). | dashboard |
| Turn on the ad-level **Website events** and **Offline events** toggles | `fix_tracking` recommendation per campaign → Approve → Execute. Appends the pixel binding (`leadgen_quality_conversion` for Instant Form ads, `offsite_conversion` for website ads) and the dataset binding (`offline_conversion`) to each ad's `tracking_specs`, keeping what is there. Minor edit: no re-review, no learning reset. Needs the client's pixel: the Settings choice, or the only pixel on the account. | dashboard, after approval |
| Add standard UTMs to active website ads | `fix_utm` recommendation per ad set → **Approve** → **Execute**. For each ad the dashboard creates a new creative on the **same Page post** (likes/comments kept) with the tags, points the ad at it, reads it back. | dashboard, after approval |
| Create a pixel where none exists | `create_pixel` recommendation → Approve → Execute. Creates an empty dataset on the ad account; nothing fires until it is connected. | dashboard, after approval |
| Turn on offline / server events (CAPI) | `fix_signal` recommendation with the exact GHL workflow steps (below). GHL workflows cannot be created through its API. | media buyer, in GHL |
| Standardise event names | `fix_signal` recommendation when a client only sends custom names ("Scheduled Appointment"). | media buyer, in GHL |
| Install the pixel on a client website | Not automatable from here; instructions in the recommendation. | client / web team |

The standard URL tag set, applied verbatim:

```
utm_source=facebook&utm_medium={{adset.name}}&utm_campaign={{campaign.name}}&utm_content={{ad.id}}
```

`utm_medium={{adset.name}}` is what the dashboard's attribution reads from GoHighLevel (`utmMedium`). Instant Form ads do not need URL tags; their attribution comes from the form → GHL field mapping.

## State at rollout (2026-09-23, 20 Meta clients)

| Situation | Clients | Recommendation written |
|---|---|---|
| Active website ads without UTMs | US Pro (18 ads across the `WEB` ad sets), Dream Home (0 active today) | `fix_utm` per ad set |
| No pixel at all | Corporate Stone, Next Key Realtor | `create_pixel` + `fix_signal` (CAPI setup) |
| Pixel present, no events in 14 days | Castles, Bay Area Remodeling, JK Plumbing, MJ Project Solutions, Canvas Moda, Paradise Decks (sheet-booked: needs a GHL step first), SnA | `fix_signal` (CAPI setup) |
| CAPI live but custom event names only | US Pro, JB's, Woodmasters, DawnSky, Tree Ninja, Teppco, Dove, Dream Home, Elite Local Pros / Austin / Hurley | `fix_signal` (standardise to Lead / Schedule / Purchase) |

## The standard GHL → Meta CAPI design

Three workflows per sub-account, all using GHL's **Facebook Conversion API** action pointed at the client's pixel/dataset:

| Workflow | Trigger | Event name | Parameters |
|---|---|---|---|
| Meta CAPI: Lead | Contact created, source is paid/Facebook | `Lead` | email, phone (GHL hashes), fbc/fbp when present, `event_id` = contact id, `action_source` = `system_generated` |
| Meta CAPI: Schedule | Opportunity stage changed → Scheduled Appointment **or** Confirmed Appointment | `Schedule` | same identifiers, `event_id` = opportunity id + stage |
| Meta CAPI: Purchase | Opportunity status → Won | `Purchase` | `value` = opportunity monetary value, `currency` = USD |

Why standard names: Meta only optimises a campaign toward an event chosen as the ad set's conversion event, and the picker offers standard events (and custom conversions built from them). Keep the existing custom events if any report depends on them; add the standard ones alongside.

After setup: Meta Events Manager → dataset → Overview should show the three events under **Server** within a day. The Integrations page's Pixel / CAPI column turns green on the next nightly check (2:05 AM) or on **Re-check now**.

## Executing a UTM fix — what to expect

- Approve, then Execute. The job runs in the background; the recommendation flips to `executed` with a per-ad log (old creative id → new creative id, read-back `url_tags`, `effective_status`).
- Meta re-reviews each swapped ad (usually minutes, occasionally hours). The ad set restarts its learning phase. Do it at a quiet time, not mid-scaling.
- Ads whose creative has no Page post id cannot be swapped this way; the log says so. Rebuild those through the Campaign Builder, which always sets the tags.
- Rollback: the recommendation's `rollback_value` holds the old creative id per ad; pointing the ad back is a one-line Graph call (`POST /{ad_id}` with the old `creative_id`).

## Where the code is

`backend/app/services/tracking.py` (proposal + execution), `backend/app/tasks/tracking.py`, routes `POST /api/integrations/propose-tracking` and `POST /api/clients/{slug}/recommendations/{id}/execute`, migration `20260923000018` (new actions `fix_utm`, `create_pixel`), UI: Integrations page button and the Execute button in the Actions card.

## Known Meta limitation (found 2026-09-23)

The Marketing API refuses `tracking_specs` edits on **Instant Form ads that were created in Ads Manager**
(errors 3390001 "choose or create an instant form" or the generic 1634013), whether the toggles are sent
together or one at a time. Website ads and ads created through the API accept the same edit. For those
ads the toggles are set in Ads Manager: select the ads → Edit → Tracking → Website events (pixel) and
Offline events (dataset) → Publish. Ads built through the Campaign Builder get the toggles at creation.

Permissions the system user needs (checked with `act_<id>?fields=user_tasks` and `me/accounts`):
`ADVERTISE`/`MANAGE` on each client ad account (7 accounts had none on 2026-09-23) and the `ADVERTISE`
task on each client Page used by ads (required to create the UTM-tagged creatives). Pixel creation on a
client-owned account is refused via API; create the dataset in Events Manager instead.
