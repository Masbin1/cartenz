# ADR-072: Email invitations and password reset

- Status: Accepted
- Date: 14 October 2026
- Supersedes: open self-registration (ADR-044), for every account after the first

## Context

Anyone who could reach the portal could register an account. An admin could
also create one, but had to choose its password and hand it over by another
channel. There was no way to recover a forgotten password without an admin.

## Decision

1. **Registration is for the first account only.** It still becomes admin, so a
   fresh deployment is manageable. Afterwards `POST /auth/register` refuses and
   the portal says to ask for an invitation.
2. **An admin invites; the person chooses the password.** Creating a user stores
   a random password nobody knows and issues an invitation link (72 hours).
3. **A forgotten password is reset by a link** (1 hour) mailed from the public
   form. The form answers the same whether or not the address exists.
4. **Links are one-time tokens**, stored as SHA-256 in `user_tokens`, consumed by
   the same statement that checks them, and invalidated when a newer link of the
   same kind is issued. Redeeming one revokes every session of the account.
5. **Mail is the delivery, not the mechanism.** SMTP is one env var
   (`SMTP_URL`, `MAIL_FROM`). With it unset, or when a send fails, the link is
   still issued and shown to the admin to share directly, so a mail outage never
   locks anyone out. Sign-in stays email and password: no magic links, for the
   same reason.

## Consequences

- New dependency: `nodemailer` (Node has no SMTP client).
- A reset is limited to one per account per two minutes. There is no per-IP
  limit yet; add one if the form is abused across many addresses.
- The admin "Set password" action stays as a fallback.

## Addendum (14 October 2026): mail settings in the portal

An admin can set SMTP host, port, TLS mode, user, password, From and the portal
URL under **Settings → Email** (`mail_settings`, one row). The password is
sealed through the secrets provider like a model API key and never returned;
the form shows only that one is stored. A saved host wins over `SMTP_URL`; with
none, the environment applies, so an env-configured server keeps working. The
portal URL there also feeds push-notification links. Settings are read on every
send, so a change applies without a restart. **Send test email** mails the
signed-in admin and reports the SMTP server's own error.

Any admin can therefore redirect where invitation and reset mail is sent. That
is within what an admin already controls, and every change is audited
(`mail_settings.updated`, without the password).

## Addendum 2 (15 October 2026): organisation domains and verified sign-up

Supersedes decision 1 for every account after the first.

- **Settings → Organization** holds a name and the allowed email domains
  (`organization`, one row). Sign-up and admin invitations refuse any other
  domain. Existing accounts outside the list keep working; an admin
  deactivates them by hand if needed. The first account's domain is added
  automatically, and migration 0030 seeds it from the first admin.
- **Self-registration is open again, from an allowed domain only.** It asks for
  no password: it creates the account with a random one and mails a `verify`
  link (24 hours) that lands on the set-password page. Sign-in is refused until
  `users.email_verified_at` is set; any redeemed link sets it, so invitations
  verify too. Existing accounts were marked verified.
- **Whether an address exists is proved only by the link.** SMTP probing
  (`RCPT TO`) was rejected: Google Workspace, Microsoft 365 and catch-all
  domains accept every address, and probing gets the server's IP listed. A
  made-up address at an allowed domain gets an account row that can never sign
  in.
- The register form answers `{ pending: true }` whether or not the address is
  taken, and re-sends a verify link at most once per two minutes. Without mail,
  self-registration is closed; invitations still work.
- Still no per-IP limit; it matters more now that sign-up is public. Unverified
  rows are not purged; add a sweep if they pile up.

## Addendum 3 (15 October 2026): HTML mail and sign-up codes

- Every mail (verify, invitation, reset, test) is HTML with a plain-text twin,
  from one `renderMail` in `mail-settings.service.ts`: inline styles, the
  logo served from the portal URL, one button. No template dependency.
- A verify mail also carries a 6-digit code, so a person who signs up on a
  laptop and reads mail on a phone finishes in the tab already open. The code
  lives on the same `user_tokens` row as the link (`code_hash`, SHA-256 salted
  with the user id); using either spends both.
- Six digits are guessable alone. Five wrong codes spend the token, counted in
  one statement so concurrent guesses cannot race, and a new mail is limited to
  one per two minutes (`POST /auth/resend-verification`). Refusals read the
  same whatever the reason, so the form reveals no addresses.
- Invitations and resets stay link-only: the person has no open tab to type
  into. Add a code to resets if asked.
