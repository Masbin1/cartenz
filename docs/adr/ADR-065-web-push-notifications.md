# ADR-065: Web push notifications for approval, completion and failure

- Status: Accepted
- Date: 25 September 2026
- Milestone: Phase 5 (connected-server estate)

## Context

An agent task can run for minutes to hours. The only way to learn a task needs
an approval, finished, or failed was to have the project's task page open, or
to poll it. Every operator so far has kept a browser tab open for exactly this
reason, which does not survive a closed laptop lid, a switched tab, or a phone.

The realtime channel that exists (`RealtimeModule`, `TaskEventsGateway`, a
WebSocket at `/ws`) only reaches a tab that already has that specific task
open - it is delivery to a page, not to a person, and it stops the moment the
tab closes. A person who is told about a task only has to notice it when they
are looking; the request here was explicitly for "even with the portal tab
closed" (operator, this conversation).

The operator asked for this after two other requests: seeing where an Odoo
Online project's instance lives from the project page (ADR-064's session), and
logging in via Odoo Online (deferred). "Push notification web gitu, buat
planningnya" - sound, on the two events that need a person: approval requests
and task completion, and (recommended, accepted without objection) task
failure as well.

## Decision

Standard Web Push (RFC 8030 `web-push` + VAPID), not a third-party push
service:

- **Recipients.** `approval_required` goes to every active admin - the only
  rank that can grant one, mirrored from `AuthorizationService`'s "admin has
  access to every project" rule rather than re-implemented. `task_completed`
  and `task_failed` go to the task's creator (`agentTasks.createdByUserId`).
  Nobody else is notified: a push is not a broadcast channel.
- **Payload is minimal on purpose.** Title, one line of body text (task
  reference + project name), the task's portal URL, and which named sound to
  play. No prompt, no diff, no tool output, no Odoo record - a push transits a
  third-party push service (Google's FCM, Mozilla's autopush, Apple's APNs)
  and sits on a lock screen; anything sensitive stays inside the authenticated
  API the notification links to.
- **One dispatcher, one hook.** `NotificationsService.dispatchForEvent` is
  called from `TaskEventPublisher.publish()` immediately after an event is
  persisted (`NotificationsModule` imported into `EventsModule`, both
  `@Global()`), for exactly `approval_required` / `task_completed` /
  `task_failed`. Every other event type (`agent_activity`, `plan_updated`,
  ...) is intentionally not in that set - see ADR risk below.
- **Fire-and-forget.** Push delivery is wrapped so it can never fail, delay or
  reject the underlying task write. Every failure is logged and swallowed; the
  task's own success or failure is unaffected by whether anyone was notified.
- **A subscription is per browser, not per account.** `push_subscriptions`
  holds one row per `(endpoint)`, foreign-keyed to a user; one person on two
  devices holds two rows. A response of `404`/`410` from the push service
  deletes that row - the standard signal a subscription is gone for good.
- **Notification collapsing.** Each push carries a `tag` -
  `task-<id>-approval` or `task-<id>-outcome` - so a second push for the same
  task replaces the first shown instead of stacking. An approval also sets
  `requireInteraction`, so it stays on screen instead of auto-dismissing.
- **Preferences, not a hidden always-on.** `notification_preferences` (one row
  per user, defaults to "everything on" when absent) lets a person turn off
  any of the three events, or the sound, from Account without unsubscribing
  the browser entirely.
- **Sound is best-effort.** A push message cannot choose its own operating
  system sound at the platform level - browsers do not expose that. The sound
  files (`public/sounds/{approval,done,failed}.wav`) are played from the
  service worker `postMessage`-ing every open tab; a *closed* portal falls
  back to the browser/OS's own default notification sound. This is a Web Push
  limitation, not a bug in this implementation.
- **No sound is doubled.** If the person is already looking at the exact task
  a push is about (tab focused, visible, URL matches), the service worker
  skips the system notification for it (the on-screen UI already shows it) but
  still plays the sound via the same `postMessage`.
- **VAPID keys live in `.env`** (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
  `VAPID_SUBJECT`), generated once with `npx web-push generate-vapid-keys` and
  read by both `cartenz-api` and `cartenz-worker`. Rotating them invalidates
  every existing browser subscription (the browser re-subscribes with the new
  public key the next time it is opened while signed in; nothing crashes, the
  old subscriptions simply 410 the next time a push is attempted).
- **PWA install is already in place** (`public/brand/manifest.webmanifest`,
  wired in `app/layout.tsx` before this change) - iOS Safari only delivers web
  push to a site added to the home screen (iOS 16.4+); this ADR did not need
  to add that, only rely on it already existing.

## What this deliberately does not do

- No native mobile app, no APNs/FCM SDK integration beyond the browser's own
  Push API - Web Push is the one channel that works the same way across
  Chrome, Firefox, Edge and installed-PWA Safari without a per-platform build.
- No email or SMS fallback. If push is unsupported or denied, the portal says
  so on Account; the person still sees the task the next time they open it.
- No per-project notification scoping. An admin gets every project's approval
  requests, matching the existing "admin reaches every project" authorization
  model instead of adding a second one.
- No notification history or read/unread state server-side. A push is
  transient the way `TaskEventsGateway`'s realtime stream already is; the task
  page itself remains the record of what happened.

## Risk and follow-up

- If `NOTIFYING_EVENTS` is ever widened without discipline (e.g. a future
  developer adds `agent_activity` to catch some other case), a busy multi-task
  project could turn into a doorbell that never stops - the choice to notify
  on exactly three, terminal, person-facing events is deliberate and should be
  revisited explicitly, not incrementally.
- The service worker (`public/sw.js`) has no fetch handler by design (no
  offline cache), so a portal deploy is never served stale by it. If a future
  change adds one, `skipWaiting()`/`clients.claim()` already in place will
  need re-checking against cache invalidation, not just push.
- Rotating VAPID keys is an operational event: document it in
  `docs/guides/service-management.md` (done alongside this ADR) so an operator
  doing routine credential rotation does not silently break every existing
  subscription without knowing why.
