# Google Ads decision report

Carl, 2026-09-24, after the hand-done US Pro / Suntek review
(`GOOGLE_ADS_REVIEW_2026-09-23.md`): *"track these metrics in the report … build a reporting
based off this so I can make better decisions."* This turns that one-off review into a
nightly report in three places.

## 1. Dashboard — client page → "Google Ads decisions" card

Shown under the Google Ads campaign table for any client with Google Search spend in the
range. One block per campaign with the headline numbers (spend, clicks, CPC, conversions,
cost per conversion colored against the client's CPL targets, calls) and **flags**:

| Flag | Rule |
|---|---|
| Junk traffic (red) | ≥200 clicks, CPC < $1.50, 0 conversions — broad match / search partners / display expansion |
| 0 conversions (red) | ≥ max($150, 2× green target) spent, nothing converted |
| No conversions in 7 days (red) | ≥$300 in the last 7 days with 0 conv on a campaign that converted before — check the tag |
| Over red line (yellow) | ≥3 conversions and cost/conv above the client's red CPL |
| Unmanaged terms (yellow) | >50% of search-term spend on queries that are not keywords (`term_status = NONE`) |
| Off-intent (yellow) | ≥$50 on repair / DIY / how-to / auto / retailer queries |
| Broad-heavy (yellow) | >50% of keyword spend on broad match |
| Weak RSAs (yellow) | an RSA with <8 headlines or Poor/Average strength |
| Landing page (red) | a final URL whose nightly check is red |
| Mixed intents (info) | one ad group holding 15+ keywords across 4+ intents |

Expanding a campaign shows tabs: **Search terms** (keyword? / spend / clicks / conv / flag:
converting, off-intent, unmanaged-no-conv, not a keyword), **Keywords** (match type, status,
metrics), **Ads** (RSA strength, final URLs, every headline and description), **Ad groups**,
**Landing pages**.

API: `GET /api/clients/{slug}/google-ads?start&end[&limit=25]`.

## 2. Google Sheet — four new tabs (rewritten 2:00 AM)

https://docs.google.com/spreadsheets/d/1xqA5Voip78bYXS7Z8XVREVMDnGbKpEW-RaKSJcYA4fQ

* **Google Campaigns** — per client × campaign, last 30 days: spend, clicks, CPC,
  conversions, cost/conv, calls, search-term spend, not-a-keyword spend and %, off-intent
  spend, broad %, ad-group and keyword counts, flags.
* **Google Keywords** — top 300 per client by spend with match type and status.
* **Google Search Terms** — top 300 per client with "Added as keyword?" (yes / negative /
  no) and a flag column; filter on `no` + 0 conversions for the negative list.
* **Landing Pages** — every URL paid ads sent traffic to in 30 days (Google final URLs and
  Meta website ads): status, HTTP code, form?, tap-to-call?, thank-you page?, flags.

## 3. Nightly landing-page checks

`landing_pages.run_checks()` runs at the start of the 2:05 AM integration-health job. It
fetches each spending URL as a phone, records HTTP status, final URL after redirects,
title, whether the HTML has a form and a `tel:` link, whether the page reads like a
confirmation page ("Thank you", "request received", "is booked"), load time, and
cross-domain redirects. App-style pages (GHL funnels: a tiny HTML shell + iframe) are
marked `client_rendered` and not judged on form/phone. Results go to
`landing_page_checks`, feed the **Landing pages** dot on the Integrations page, the
Daily Brief (`landing_page_broken`, red), the client card and the sheet tab.

Why: on 2026-09-23 the root domain uspropaint.com, final URL of a live Search campaign,
was serving "Thank You! Your Free Consultation Is Booked" to 850 clicks a month. By the
next morning it was a 404. Nothing in the metrics would ever have shown it.

## 4. Daily Brief rules added

* `google_junk_traffic` (red, proposes pause): ≥100 clicks in the week under $1.50 each
  with no conversions.
* `google_unmanaged_terms` (yellow): >50% of the week's search-term spend on non-keywords.
* `landing_page_broken` (red): any red landing page, with the 30-day spend sent there.

## Not automated (yet)

Applying negatives, pausing campaigns and changing match types is still done by hand in
Google Ads; the plugin has no Google write tools. Campaign-level settings (search
partners, display expansion, location "presence" vs "interest") are not readable from the
tables we sync, so those remain a checklist item in the review doc.
