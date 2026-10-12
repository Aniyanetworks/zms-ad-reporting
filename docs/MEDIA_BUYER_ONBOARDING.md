# Media buyer onboarding

How the Agency Owner (role `admin`) gives a media buyer access to the dashboard, what that role
can do, and how to take access away. Production URL:
https://adbuildout.contractorscalingblueprint.com (alias https://report.contractorscalingblueprint.com).

## 0. One-time prerequisites (Carl)

1. Run `scripts/cloud/supabase-auth-hardening.py --apply` (see `SUPABASE.md`). It sets sign-up to
   invite-only, the 12-character letters + digits password policy, the leaked-password check, the
   12 h session timebox, and the redirect allow-list.
2. Confirm the redirect allow-list (Supabase Dashboard -> Authentication -> URL Configuration ->
   Redirect URLs) covers the callback routes. The script adds `/**` wildcards for these hosts,
   which is sufficient:
   - `https://adbuildout.contractorscalingblueprint.com/auth/callback` (and `/auth/complete`)
   - `https://staging-adbuildout.contractorscalingblueprint.com/auth/callback` (and `/auth/complete`)
   - `https://report.contractorscalingblueprint.com/auth/callback` (legacy alias)
   - `http://localhost:3000/auth/callback` (local dev)
   Site URL must be the production origin. If a link lands on the wrong host or on `/` with an
   error, the allow-list is the first thing to check.

TODO (Carl) until both are done.

## 1. Invite (Supabase Dashboard)

1. Open https://supabase.com/dashboard/project/ayxvikfnktlxtpgzcrok/auth/users
2. **Add user -> Send invitation** (labelled "Invite user"), enter the media buyer's work email,
   send.
3. The trigger `handle_new_user()` creates the `profiles` row with role `viewer` (read-only).

What the link does: `{{ .ConfirmationURL }}` -> `/auth/callback` (`frontend/src/app/auth/callback/route.ts`)
-> `/auth/complete` (implicit flow: the tokens are in the URL fragment, so a client page sets the
session) -> `/set-password` -> `/`. Invite links expire (Supabase default 24 h); an expired or
reused link redirects to `/login` with the error text. Re-send the invitation from the same
Users page if that happens.

Fallback (no email access, or link problems): **Add user -> Create new user**, work email, a
generated password (12+ chars, letters + digits), **Auto Confirm User** on. Hand the password over
in the shared password manager, never in chat or email. The buyer should change it on
`/account` at first login.

## 2. Set the role (SQL Editor, same project)

```sql
update profiles
set role = 'media_buyer'
where id = (select id from auth.users where email = 'buyer@example.com');

-- check
select u.email, p.role from profiles p join auth.users u on u.id = p.id order by u.email;
```

Valid roles: `admin` (Agency Owner), `media_buyer`, `viewer`. Anything else is rejected by the
`profiles_role_check` constraint (migration `20260917000011`). The api reads the role on every
request, so the change is live on the person's next page load. Do this right after sending the
invite; until then the buyer is a viewer and cannot approve.

## 3. What the media buyer receives

- An email from Supabase Auth with an **Accept the invite** link. It signs them in and opens
  **Set your password**.
- Password rules (`frontend/src/lib/password.ts`, same as the Supabase project config): **12 or
  more characters, at least one letter and one digit**; rejected if it appears in known breach
  lists (HaveIBeenPwned check).
- Sessions last at most **12 hours**, then they sign in again at `/login`.
- **Forgot password?** on `/login` emails a recovery link (PKCE). The link must be opened in the
  **same browser** that requested it; opened elsewhere, `/login` shows "PKCE code verifier not
  found". Fix: click Forgot password again from the browser you will open the email in.
- `/account` (nav -> Account): change password, enrol or remove TOTP two-factor.

## 4. MFA enrolment (`/account`)

Recommended for media buyers, expected for the Agency Owner.

1. Sign in, open **Account** from the nav.
2. **Two-factor authentication (TOTP)** -> **Enrol authenticator app**.
3. Scan the QR code with 1Password, Google Authenticator or Authy (or type the key shown under
   "Can't scan?").
4. Enter the 6-digit code -> **Verify & enable**. The factor shows as `enabled` with the date.
5. To remove a device: **Remove** next to the factor. Unfinished enrolments are listed with a
   **clean up** link.

Lost device: the owner removes the factor in Supabase -> Authentication -> Users -> user ->
Multi-factor, then the buyer re-enrols. MFA is not enforced at sign-in yet (the Supabase project
has TOTP enabled, not required); TODO (deploy) if the owner wants it mandatory.

## 5. Permissions

| Action | admin (Owner) | media_buyer | viewer |
|---|---|---|---|
| View Overview, Portfolio, client pages, Services, Sync status | yes | yes | yes |
| Approve a recommendation (pause, refresh_creative, fix_signal, investigate, budget_change <= 20 %) | yes | yes | no |
| Approve a `budget_change` increase above 20 % | yes | **no** (403, logged as `recommendation.approve_denied`) | no |
| Approve `activate` | no, nobody: launch happens in Ads Manager by a person | no | no |
| Dismiss a recommendation | yes | yes | no |
| Add / edit clients, GHL tokens, targets (Settings) | yes | no | no |
| Trigger a manual sync (Settings) | yes | no | no |
| Read the audit log (`GET /api/audit-log`) | all rows | own rows only (via RLS; no UI yet) | own rows only |
| Change own password, manage own MFA (`/account`) | yes | yes | yes |
| Run the Claude Code plugin (`/weekly-triage`, `/execute`, `/build-campaign`) | yes | yes, with their own plugin `.env` (see `~/zeal-paid-ads/docs/TEAM_HANDOFF.md`) | not intended |

Rules are enforced server-side in `backend/app/core/policy.py`; the UI only hides buttons.

## 6. First-login checklist (send to the media buyer)

1. Open the invite email and click **Accept the invite**. Set a password: 12+ characters with
   letters and digits. You land on the dashboard signed in.
2. Bookmark https://adbuildout.contractorscalingblueprint.com. If you are outside the US, use a
   US VPN (Cloudflare challenges non-US traffic).
3. Confirm the nav shows your role as **Media buyer**. If it says **Viewer**, ask Carl to set the
   role (section 2).
4. Open **Account** and enrol an authenticator app (section 4).
5. Open a client page -> **Actions** card. You should see Approve / Dismiss on open
   recommendations, and a lock note on budget increases above 20 %.
6. Settings page: you should see the "limited to the Agency Owner" notice, not the client forms.
7. If you will run the plugin: complete sections 2 to 5 of `~/zeal-paid-ads/docs/TEAM_HANDOFF.md`
   (Claude Team seat, Meta Business Manager assignment, `PLUGIN_API_TOKEN`, read-only Supabase
   token, per-client GHL PIT). Ask Carl for values in the password manager, never in chat.
8. Staging (https://staging-adbuildout.contractorscalingblueprint.com): you will first get a
   Cloudflare Access email PIN prompt (any `@zealmediasolutions.com` address), then a separate
   staging login. Staging has its own users; ask Carl to invite you there too if needed.

## 7. Revoking access

Production dashboard (Supabase project `ayxvikfnktlxtpgzcrok`):

1. Authentication -> Users -> the user -> **Ban user**. Immediate for new sign-ins; the current
   session ends within the 12 h timebox at the latest. **Prefer ban over delete**: the audit
   trail and approval history keep the person's id and email.
2. **Delete user** only if they must disappear entirely. `profiles` cascades;
   `recommendations.approved_by_id` becomes null (`on delete set null`, migration 11) while the
   display column `approved_by` (email) and `audit_log.actor_id` / `actor_email` remain.
3. Remove their MFA factors and sessions come with the ban; nothing else to do in Supabase.

Plugin access: rotate `PLUGIN_API_TOKEN` in `backend/.env` (restart api) and the per-client GHL
PITs they held; remove them from the GitHub repo `zmsseoagency/zeal-paid-ads` and from Meta
Business Manager. See `CREDENTIALS_CHECKLIST.md`.

Staging: Cloudflare Zero Trust -> Access -> Applications -> "ZMS Ads - staging" -> policy: if
they are listed by email, remove them; if they matched by `@zealmediasolutions.com`, disable
their Google Workspace account. Then ban the user in the staging Supabase project as well.

## 8. Audit

Every approve / dismiss / denied approval is written to `audit_log` with `actor_id`,
`actor_email`, `ip` (Cloudflare `CF-Connecting-IP`) and `user_agent`. Owner view:

```sql
select at, actor_email, action, entity_id, client_id
from audit_log where actor_email = 'buyer@example.com' order by at desc limit 50;
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Invite link opens `/login` with "invalid or has expired" | link older than the expiry, or clicked twice | re-send the invitation |
| Link lands on a Supabase error page about redirect URL | host missing from the redirect allow-list | section 0 step 2 |
| `/login` shows "PKCE code verifier not found" after a reset link | recovery link opened in a different browser than the one that requested it | request Forgot password again from that browser |
| Password rejected although 12+ chars | needs at least one letter and one digit; or it is on a breach list | pick another |
| Approve buttons missing | role still `viewer` | section 2 |
