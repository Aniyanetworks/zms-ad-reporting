# Google Ads review — US Pro Painter & Renovation and Suntek Exteriors

*Window: last 30 days to 2026-09-23. Sources: `ad_metrics_daily`, the new
`google_adgroup/ad/keyword/search_terms` tables, GHL, and a live render of every landing
page (mobile + desktop). Recommendations are proposals for Carl / the media buyer to apply
in Google Ads; nothing here was changed automatically.*

## Headline findings

1. **uspropaint.com (the root domain) is serving a "Thank You! Your Free Consultation Is
   Booked" page** on mobile, desktop and www. The Search-26 campaign sends every click
   there: 853 clicks in 30 days landed on a thank-you page. Anyone typing the brand domain
   sees it too. Highest-priority fix.
2. **Search-26 is junk traffic**: 15 broad keywords ("painting", "home services near me",
   "house repairs", "tile installation"), $0.47 CPC, 8.5% CTR, search terms like "plumber
   near me" and "highly rated roofing companies near me", 0 conversions. Pause it.
3. **US Pro Cabinet Painting is the only Search campaign with real conversion volume**
   (11 in 30 days) but at $339 per conversion against a $75–150 target, and **zero
   conversions since Sep 15 while spending ~$1,500** — either the offer/LP stopped
   converting or the conversion tag on service.uspropaint.com stopped firing. Verify the
   tag first.
4. **84% of US Pro's search-term spend and 72% of Suntek's is on queries that are not
   keywords** (phrase match expansion), including ~$700 on competitor kitchen showrooms
   for US Pro and $178 on two competitor-brand clicks for Suntek. Negatives + exact match
   on the proven terms is the biggest efficiency lever.
5. **Refacing intent converts, remodel intent doesn't**: "cabinet refacing" terms produced
   3 of US Pro's 9 attributed search-term conversions; "kitchen remodel cost" spent $273
   for 0.

---

## US Pro Painter & Renovation (customer 5293768200)

| Campaign | Spend | Clicks | CPC | Conv | Cost/conv | Calls | Verdict |
|---|---|---|---|---|---|---|---|
| Cabinet Painting \| 22-Aug-26 | $3,728 | 182 | $20.48 | 11 | $339 | 2 | Keep, restructure |
| Kitchen Remodeling - 21 Aug 26 | $3,327 | 138 | $24.11 | 4 | $832 | 5 | Cut back |
| 9-Feb-26 \| P-Max | $429 | 236 | $1.82 | 3 | $143 | 9 | Keep, test +30% |
| Search-26 (Restoration) | $399 | 853 | $0.47 | 0 | — | 0 | Pause now |

GHL for the same window: 229 paid-attributed contacts, 67 paid appointments (all
platforms). Google-sourced appointments cannot be separated per campaign because the
Google final URLs carry no UTM parameters (see "Tracking" below) — fix that before judging
Google on appointments the way we do Meta.

### Cabinet Painting | 22-Aug-26 — keep, restructure

*Setup today*: one ad group ("Cabinet Painting"), 2 RSAs (GOOD + EXCELLENT strength) to
`service.uspropaint.com/cabinet`, ~30 keywords mixing painting / refinishing / refacing
intent, phrase-heavy (phrase $5.3k vs exact $1.8k across the account).

*What the data says*
- Converting search terms: cabinet refacing (1.5), cabinet refacing near me (1), local
  cabinet refacing (0.5), kitchen cabinet painting (1), cabinet door painting (1), cabinet
  painting cost (0.5), cabinet painting cost per linear foot (0.5), kitchen cabinet
  refinishers near me (1). Refacing + cost intent wins.
- Wasted: competitor showrooms — watch city kitchens $139, cape and islands kitchens
  $105, franklin kitchen center $103, kitchen creations $164, revelare kitchens $86,
  redoor cabinets $78, your german kitchen $32, kitchen nation boston $41, kitchen
  options of new england $31 (≈ $780, 1 conversion). DIY — "paint for kitchen cabinets"
  $48, "cabinet paint" $32. Off-service — "how much to replace countertops" $66,
  "bathroom cabinet refacing" $38.
- Daily trend: conversions on 9/12, 9/13, 9/14 then **none from 9/15 to 9/22 across
  ~$1,500 of spend**.

*Changes*
1. Verify the Google Ads conversion tag fires on the `/cabinet` form submit and on the
   GHL calendar booking (GTM is on the page; no `AW-` tag is inline). If it broke on
   ~9/15, the campaign is being judged blind and Smart Bidding is starving.
2. Split into 3 ad groups with matching RSA headlines: **Cabinet Refacing**,
   **Cabinet Refinishing / Repainting**, **Cabinet Painting Cost** (price-anchored copy:
   "From $X", financing). The existing EXCELLENT RSA already leads with refinishing.
3. Move proven terms to exact: [cabinet refacing], [cabinet refacing near me],
   [cabinet refinishing near me], [kitchen cabinet painting], [cabinet painting cost],
   [cabinet refinishers near me]. Keep phrase only on "cabinet refacing", "cabinet
   refinishing", "cabinet painting".
4. Negative list (campaign level, phrase): watch city, cape and islands, franklin kitchen,
   kitchen creations, revelare, redoor, german kitchen, kitchen nation, kitchen options,
   rusty rose, paint for, cabinet paint, spray paint, diy, how to, countertop,
   countertops, bathroom cabinet, ikea, home depot, lowes, jobs, salary.
5. Budget: hold until the tag is verified, then let refacing carry the spend.

### Kitchen Remodeling - 21 Aug 26 — cut back

*Setup today*: one ad group, 2 RSAs ("Kitchen Remodel From $16,999"), landing
`service.uspropaint.com/kitchen`, phrase-heavy contractor + cost keywords.

*What the data says*: $832 per conversion; "contractor for kitchen remodel" $985 → 1,
"kitchen remodeling massachusetts" $576 → 0, "kitchen remodel contractors" $386 → 0,
"kitchen remodel cost" + "kitchen redesign cost" $253 → 0. High-ticket intent with a
$24 CPC needs far more than 138 clicks to work, and the only converters were "kitchen
renovation massachusetts" (1), "kitchen renovation contractors" (1), "kitchen reno near
me" (1).

*Changes*
1. Cut daily budget by half and move the difference to Cabinet (refacing) and P-Max.
2. Exact match only: [kitchen renovation contractors], [kitchen remodel contractors near
   me], [kitchen renovation massachusetts], [kitchen remodeling contractors]. Pause the
   "cost" keywords or route them to a pricing-anchored section.
3. Same negative list as Cabinet plus: ideas, pictures, design software, ikea, cabinets
   only, outdoor kitchen, commercial (the LP advertises commercial kitchens — remove that
   block if the goal is homeowner appointments).
4. Judge it on GHL appointments after UTMs are in place (see Tracking); if kitchen
   remodel leads book at a materially higher rate than cabinet leads, the $832 may be
   acceptable given a $16,999+ ticket. Carl's rule: judge on appointments, not CPL.

### 9-Feb-26 | P-Max — keep, test +30%

$429 for 3 conversions and 9 calls (cheapest signal in the account). Confirm which asset
group / final URL it uses (should be the `service.uspropaint.com` pages, not the root
domain), add the refacing offer as an asset group, then raise budget ~30% and re-check in
two weeks.

### Search-26 (ad group "Restoration") — pause now

- 15 **broad** keywords: painting $97/128 clicks, home services near me $63/44, house
  repairs $39/48, tile installation, bath redo, bathroom remodeling ideas, drywall …
- Search terms: "house painting websites", "house painting articles", "plumber near me",
  "highly rated roofing companies near me", "paint". 853 clicks at $0.47 with 0
  conversions is bot/partner-network traffic, not homeowners.
- RSA has 7 headlines, 2 descriptions, AVERAGE strength, no CTA, and its final URL is
  **`https://uspropaint.com`, which renders the thank-you page**.

Pause it. If a general painting campaign is wanted, build it new: exact/phrase on
"interior painting", "exterior painting", "house painters near me", search network only
(no partners, no display expansion), landing on
`exterior-painting.uspropaint.com/exterior-painting` (already used by Meta).

### Landing pages (US Pro)

| URL | Verdict |
|---|---|
| `service.uspropaint.com/cabinet` | Good: phone top-right, form above the fold, "we'll take you straight to our calendar". Fix: `<title>` is the kitchen page's title (both pages share "Kitchen Remodeling & Cabinet Refinishing in Massachusetts"), copy is stuffed with "near me" phrases ("our expert cabinet painters near me transform…") which reads as spam and hurts trust, no visible price anchor although "cost" queries convert. Add "Refacing" as its own headline block since that intent converts best. |
| `service.uspropaint.com/kitchen` | Same template, same strengths. Fix: remove the Commercial Kitchens and Outdoor Kitchen blocks (dilutes homeowner intent), put the "$16,999" anchor from the ads on the page (message match), title tag unique. |
| `uspropaint.com` | **Broken: root serves a thank-you page.** Restore the homepage or 301 it to `service.uspropaint.com`, and move the thank-you step to `/thank-you`. Also check that the Google Ads conversion for "booked" isn't defined as a page view of this URL — if it is, every visit to the homepage would count as a conversion (it currently shows 0 for Search-26, so probably not, but confirm). |
| Meta LPs (`bathroom./cabinet-painting./exterior-painting./kitchen.uspropaint.com`) | Not affected; all 875 fb.me ads are Instant Forms. |

On all pages: confirm the phone number is a tap-to-call `tel:` link on mobile (the
server HTML has none; it may be added by the page script) and that the GTM container
fires the Google Ads conversion on form submit **and** on calendar booking.

### Tracking (US Pro)

- Google final URLs carry no UTMs, so GHL can't tell us which Google campaign booked.
  Add an account-level **final URL suffix**:
  `utm_source=google&utm_medium={_cn}&utm_campaign={_cn}&utm_term={keyword}&gclid={gclid}`
  and a custom parameter `{_cn}` on each campaign (Cabinet Painting, Kitchen Remodeling,
  P-Max). GHL reads `utm_medium` as the ad-set name, so the dashboard will then show
  Google appointments per campaign exactly like Meta.
- Search-26's traffic pattern suggests Search Partners / Display Expansion is on at
  campaign level; turn both off in every Search campaign.

---

## Suntek Exteriors (customer 2094542792)

| Campaign | Spend | Impr | Clicks | CPC | Conv | Verdict |
|---|---|---|---|---|---|---|
| 16-Sep-26 \| V1 (Search) | $315 | 241 | 12 | $26.25 | 0 | Keep, fix keywords + negatives |
| LSA (system generated) | $136 | 1,092 | 61 | $2.23 | 2 | Lean in |
| Garland County | $34 | 947 | 67 | $0.50 | 0 | Leave paused (same junk pattern as Search-26) |

No GHL location is linked for Suntek, so there is no appointment truth for either
campaign — only Google's conversions. Link the GHL sub-account (or at least a call
tracking number) before spending more.

### 16-Sep-26 | V1 — one week old, too early on conversions, but the keyword set is wrong

*Setup*: one ad group, one RSA (GOOD) to `window.suntekexteriors.com/window-installation`,
15 keywords (11 phrase, 4 exact).

*What the data says* (12 clicks, so directional only)
- $178 of $315 (56%) went to **two clicks** on competitor brands: "winchoice hot springs
  ar" $98, "window world arkansas" $80. Neither is a keyword; phrase match on "window
  replacement service" / "window installation companies" pulled them in.
- Repair / glass intent: "how much it cost to fix a window" $52, "window repair
  bentonville ar" $21, "glass window repair near me" $16, "replace front windshield cost"
  $7. Several are already EXCLUDED (good), but the keywords **"window glass
  replacement"** (phrase + exact, $51) and **"window screen replacement"** invite exactly
  this traffic. Suntek sells full replacement windows; drop them.
- Geography: Bentonville and Texarkana clicks are far outside Hot Springs / Little Rock.
  Check location targeting is "presence" not "presence or interest" and tighten the
  radius.

*Changes*
1. Remove keywords: window glass replacement (both), window screen replacement (both),
   front window replacement cost. Keep: window replacement, replacement windows prices,
   window replacement companies, home window replacement, new windows for home, window
   installation companies, double hung windows.
2. Add exact: [window replacement hot springs], [window replacement little rock],
   [replacement windows arkansas], [window installers near me], [window replacement
   companies near me], [energy efficient windows arkansas].
3. Negatives (phrase): winchoice, window world, pella, andersen, marvin, atrium, hanke,
   royal windows, windows doors and more, pro windows, repair, fix, glass, windshield,
   screen, pane, car, auto, blinds, tint, film, diy, how to, bentonville, texarkana,
   fayetteville, jonesboro.
4. Bidding: at $26 CPC with a ~$10/day budget it gets ~12 clicks a month, which can't
   learn. Either raise to $40–50/day for 3 weeks on Maximize Clicks → then tCPA, or put
   the money into LSA, which is already producing at $68/lead.
5. Turn off Search Partners and Display Expansion; the paused Garland County campaign
   ($0.50 CPC, 7% CTR, 0 conv) shows what that traffic looks like.

### Landing page (Suntek)

`window.suntekexteriors.com/window-installation` — solid structure: phone top-right,
strong headline, three trust bullets, reviews, a two-step form ("What type of project? →
Do you own this home?").

Fixes:
- The form's first question offers Windows / Roofing / Siding / Exterior Doors. On a
  window campaign, pre-select Windows or remove the step — every extra tap loses mobile
  visitors.
- Copy is keyword-stuffed ("experienced window installers near me", "new windows for
  home") — rewrite for humans; Google's landing-page experience score reads this too.
- No price/financing anchor while "cost" queries appear; add "Financing available" and a
  "from $X per window installed" line if Suntek will stand behind one.
- Verify tap-to-call `tel:` link and that the Google Ads conversion fires on step-2
  submit (GTM present, no inline `AW-` tag).

---

## Order of operations

1. **Fix uspropaint.com root** (thank-you page) and **verify Google conversion tags** on
   both service.uspropaint.com pages — same day.
2. Pause Search-26. Turn off search partners / display expansion on every Search campaign
   (both accounts).
3. Apply negatives and exact-match lists above (both accounts); remove Suntek's
   glass/screen keywords.
4. Add the final-URL-suffix UTMs so GHL appointments split by Google campaign.
5. Restructure Cabinet Painting into refacing / refinishing / cost ad groups; halve the
   Kitchen Remodeling budget; +30% P-Max.
6. Re-review in 14 days on **paid appointments per campaign**, not CPL.
