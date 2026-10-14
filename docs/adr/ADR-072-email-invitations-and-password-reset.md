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
