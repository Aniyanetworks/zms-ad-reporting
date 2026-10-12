# Data hygiene checklist — the fixes that make the dashboard's numbers true

Findings from the 2026-09-21 audit. Each item is a setting in Ads Manager or GHL
(not code). Until it's done, the affected numbers are estimates or blanks.

## 1. Ad URLs must carry the ad-set UTM (Ads Manager)
**Why:** GHL attributes a lead to a campaign only from `utm_medium`, which must be the
ad set name. Without it the lead lands untagged and its booking can't be tied to a
campaign; per-campaign CPBA becomes an allocation.

**Every website ad's URL parameters field:**
```
utm_source=facebook&utm_medium={{adset.name}}&utm_campaign={{campaign.name}}&utm_content={{ad.id}}
```
Found missing on **all 24 active US Pro Painter website ads** (the 17/18-Sep landing
page campaigns: Kitchen Remodeling, Exterior Painting, Cabinet Painting, Bathroom
Remodeling LP) and **both Dream Home Renovations `11-Sep-26 | ICP Test | Web` ads**.
The nightly brief now flags this per campaign (`missing_utm`) and the creative sync
records it, so the list stays current on the Daily Brief page.

Also confirm the landing pages pass the UTMs through the multi-step form to GHL
(the US Pro funnels are 3-step; UTMs must survive to the contact).

## 2. Instant Form → GHL integration must mark leads as paid (GHL)
**Why:** the dashboard counts a contact (and its booking) as paid only when GHL's
attribution says so: `sessionSource = Paid Social`, or an `adId`/`campaignId`, or a
paid `utm_medium`. US Pro Painter's forms do this correctly (leads arrive as
"Paid Social", utmMedium = ad set name, adId set). **Corporate Stone's and SnA Home
Improvement's** Facebook leads arrive as "Social media / facebook" with no ad id —
so they show **0 paid contacts and 0 paid appointments** even though ads run.

**Fix per sub-account:** GHL → Settings → Integrations → Facebook Form Fields
Mapping: map the lead form's hidden fields (ad id, ad set name → `utm_medium`,
campaign) to the contact's attribution/UTM fields, exactly as US Pro's is mapped.
Then re-sync GHL for the client (Settings → Sync ghl) and the paid numbers appear.

## 3. Closers enter the job value on every Won opportunity (GHL)
**Why:** `revenue_won` is $0 almost everywhere and no client had an average job value,
so the dashboard couldn't say whether a $212 booked appointment is good. It now has a
**profitability ceiling per client**:
`max CPBA = avg job value × close rate × gross margin × max ad share of profit`
(defaults 25% / 35% / 30%; all four editable per client in Settings). Cost per
appointment is colored against it on Overview, Portfolio and in the Daily Brief
(`cpba_unprofitable` is a red flag).

**Ask of the closers:** when an opportunity moves to Won, fill in the monetary value.
Until then, set each client's avg job value by hand in Settings (Paradise's sheet
gives ≈ $19k; ask each client for their typical ticket otherwise).

## 4. Google conversion actions (Google Ads) — mostly fine
Audit of every mapped account (last 30 days): only real lead actions are counted —
LSA phone/message leads, "Calls from ads", and US Pro's "Submit lead form" actions.
Page views, directions and GA4 page_view are correctly **not** counted. Woodmasters'
historical "197 leads on $732" predates this and both of its accounts have been
paused since mid-August; re-check the conversion actions there before relaunching.

## 5. Appointment stage discipline (GHL)
Bookings are counted from opportunities in the **Scheduled Appointment / Confirmed
Appointment** stages (paid-sourced only). Next Key Realtor has 67 paid contacts and
zero bookings in 30 days — either setters aren't moving opportunities into the stage
or booking happens outside GHL. Check with the setters.
