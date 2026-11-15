# Phase 4E Task Contract — deterministic cards/chips and side-effect-free booking mock states

## Objective
Add the smallest provider-neutral UI increment to `@pilgrim/widget`: deterministic recommendation cards/chips and a typed, mock-only booking flow rendered inside the accessible chat panel. The seam is fixture-driven and callback-injected; it must not perform booking or persistence side effects.

## Public contract
- Add typed fixture data for cards and chips. A card has a stable `id`, non-empty `title`, `description`, and deterministic `priceLabel`; optional `chips` contain stable `id` and non-empty `label`. Rendering preserves input order and renders all values as text nodes only.
- `mountPanel` accepts optional `fixtures?: { cards: PanelCard[] }` and optional `onBookingAction?: (action: BookingAction) => void`. Callbacks are notifications only and must not be required for rendering or state transitions.
- `BookingAction` is a discriminated union with `type: 'select_card' | 'confirm_booking' | 'cancel_booking'`, a `cardId` for selection/confirmation, and no provider, network, storage, or persistence fields.
- The panel renders cards/chips only from the injected fixture. No fetch, client, stream, timer, storage, URL, random, or provider call is introduced by this increment.

## Deterministic UI behavior
- Cards appear in a labelled `list`; each card is a `listitem` with its title, description, price label, and chips. Chips are non-actionable text labels unless explicitly represented as buttons by the existing accessible control pattern.
- Each card has a native `button` labelled `Book <title>`. Activating it transitions that card to mock `selected` state and emits `{ type: 'select_card', cardId }` once.
- Selected state is represented accessibly (`aria-pressed="true"` or equivalent) and exposes a native `Confirm booking` button plus `Cancel` button for that card. Confirm emits `{ type: 'confirm_booking', cardId }` once and transitions to deterministic `confirmed` state with visible text `Booking request ready for <title>.` Cancel emits `{ type: 'cancel_booking', cardId }` once and returns to the unselected state.
- A confirmed card has no further booking action controls. The visible copy must say the request is ready/mock only; it must not claim a real booking was made.
- Repeated activation of the same state is idempotent: no duplicate callback for an already-selected/confirmed/cancelled no-op. Selecting a different card replaces the previous mock selection deterministically.
- Existing chat launcher, keyboard, streaming, error, retry, isolation, and accessible semantics remain intact.

## Explicit exclusions
No real booking API/provider, backend route, credentials, payment, inventory hold, mutation, persistence/session resume, analytics, deployment/publishing, mobile/screen-reader/Lighthouse certification, or Phase 5 work. This is not a booking integration.

## Acceptance
1. Focused tests cover typed fixtures, stable card/chip ordering and text-only rendering, selection/confirm/cancel state transitions, callback payloads/idempotency, empty fixtures, and no side effects.
2. Existing widget tests plus widget typecheck and deterministic bundle build pass; repeated builds are byte-identical and generated bundle artifacts are updated only through the existing build path.
3. Static inspection proves no new network/storage/provider/persistence/booking implementation exists beyond injected notification callbacks.
4. Independent QA runs against the exact immutable candidate SHA, followed by disposable local WordPress/browser validation. Only after QA PASS may the exact candidate be fast-forward promoted to `origin/staging`; `origin/main` must remain unchanged.
