# Studio visual baseline — 2026-09-12

## Selected reference

The maintainer delegated design selection before implementation. The actual
image generated in the development conversation was selected as the visual
reference, then converted to an editable Canva design: **DAHU-LD7UQ8**,
https://www.canva.com/d/JHiuhsPOmupv0h7 . This records agent selection, not a
claim that the maintainer personally approved an individual image.

Original reference PNG SHA-256: `9bb5d9d933e0980f1a2b22bd78fbdcd6653b2a5951985e6a0549568855b93b2a`.

The reference has a warm neutral canvas, white surfaces, dark readable Japanese
text, restrained green actions, a mobile booking flow, a desktop navigation rail,
resource/time lanes, and a separate pending-review panel. It uses fictional data.
No private screen, customer data, provider identifier, or production asset was
sent to the image service. Conversion to Canva is not claimed as a second visual
refinement pass.

## Implemented slice and deliberate differences

This slice retains the existing public application's booking stages, validation,
API calls, authorization, idempotency keys, confirmation states, cancellation,
provider opt-in, and all existing browser regressions. It changes presentation;
it does not copy or generalize private production source or claim migration parity.
The existing Reimplemented provenance of the customer/operator flow is unchanged.

The customer flow keeps its honest three stages: selection, contact, review.
Native date entry remains available; a keyboard-operable week strip supplements
it and respects the current booking window. The strip does not assert availability.
Status/error/consent/management-key guidance remains present, not hidden for aesthetics.

The operator timetable reads the same authoritative day response as the agenda.
Occupied time includes cleanup. Global closures cover every lane, and resources
referenced by existing bookings are not silently dropped. Contact details are
shown in the protected detail panel, not the dense agenda/timetable.

The full agenda remains below the timetable and is the primary mobile surface.
Reservations shorter than 30 minutes, more than four resources, invalid layout
data, or overlapping intervals use the agenda instead of clipped controls.
Cancelled/completed/rejected/expired/no-show records remain in the agenda.
The timetable never represents blank space as bookable capacity. Status filters
show the filtered agenda without a misleading incomplete capacity picture.

No customer CRM, unsupported menu, month view, drag-to-reschedule interaction,
new storage backend, multi-location transaction, or cross-day migration is
implied by decorative controls. Detail editing stays in the existing panel rather
than an unverified drawer. The seven-day view remains the sign-in default.

## Verification and screenshot comparison

The pure layout/date cases in `test/studio.test.ts` were written first and failed
against stub behavior before implementation. Browser checks in
`tests-browser/studio.spec.ts` exercise date input/keyboard synchronization,
real booking creation, timetable-to-detail interaction, contact visibility,
logout clearing, narrow screens, dark themes, and reduced motion. Real rendered
screenshots are attached by these tests for reference comparison.

Review the final screenshots against the reference for: (1) warm restrained
palette, (2) compact mobile stage hierarchy, (3) readable date/slot controls,
(4) desktop rail plus schedule/pending hierarchy, and (5) status and failure-state
legibility. A passing functional test alone does not establish visual fidelity.
Record the actual run and observed remaining differences in the PR before merge.
