# ADR-089: Push notifications go to the task's creator only

- Status: Accepted
- Date: 3 November 2026
- Milestone: Phase 5 (connected-server estate)
- Supersedes: ADR-065's recipient rule for `approval_required`

## Context

ADR-065 routed a push for `approval_required` to every active admin -
mirrored from `AuthorizationService`'s "admin reaches every project" rule,
on the reasoning that only an admin may decide an approval, so a non-admin
requester could not act on one anyway.

In operation, that produced exactly the complaint this ADR is named for: "notif
nya malah masuk ke user lain, padahal kan user A yang request, harusnya notif
nya masuk ke yang request aja". On a deployment with several admins (this
one has three), a task any one of them submits pushes a notification to the
other two as well, for a task they did not ask about and may have no other
reason to be looking at. The admin-wide push was the design's own answer to
"who may act", not to "who asked" - and the person who asked is who a push
is addressed to in every other respect ADR-065 already established
(`task_completed`/`task_failed` always went to the creator alone).

## Decision

`NotificationsService.recipientsFor` now returns the task's creator
(`agentTasks.createdByUserId`) for every notifying event, including
`approval_required`. The admin-wide branch is removed entirely; the method
no longer needs the event kind to decide recipients.

An admin who did not create the task is not pushed a notification for one
that needs their decision. They are not cut out of the approval itself:
`GET /approvals` (the Approvals page) lists every pending approval across
every project an admin can reach, exactly as before - this ADR changes who
is proactively pushed, not who may act or what they can see. A project with
one admin who created the task, by far the common case, is unaffected: that
admin was always in the recipient set, as the creator.

## Consequences

- A non-admin creator is pushed their own task's approval even though they
  cannot grant it themselves - unchanged from before this ADR, since the
  creator was always included when they happened to also be an admin, and
  excluded only by being a non-admin whose own request produced a push to
  everyone else instead of to them. That asymmetry (told about something you
  cannot act on) is accepted here the same way it already was for
  `task_completed`/`task_failed`: being notified about your own task's state
  is still the useful signal, even when the next action requires someone
  else.
- An admin who wants to be told the moment ANY approval is pending, not just
  their own tasks', loses the push that gave them that today. No replacement
  "notify all admins of every approval" setting is introduced - the premise
  of this ADR is that a push belongs to the person who asked, not to every
  person who could technically act. An admin who needs that visibility reads
  the Approvals page, which already lists everything (unaffected by this
  change) and is a page, not a push, because this ADR deliberately narrows
  the one channel designed for a single interested recipient rather than
  widen it with a parallel broad one.
- `NotifyingEvent` is still threaded through `dispatchForEvent` for
  `isNotifyingEvent`/`eventWanted` (which event happened, and whether this
  recipient wants that kind of push); only `recipientsFor` lost its
  dependency on it, because recipient selection no longer branches on event
  kind.

## Testing

- `notifications.service.spec.ts`: a renamed existing test confirms
  `recipientsFor` is now called with just the creator id for both
  `approval_required` and `task_completed` (no event-kind argument).
- A new `describe('NotificationsService.recipientsFor (ADR-089)')` exercises
  the method unmocked against a users table mixing an admin who is not the
  creator and a non-admin who is: the creator is returned regardless of
  their `isAdmin` flag, and the non-creator admin is never returned.
