# Data model: recovery evidence

No application schema changes.

The test baseline captures `core_state`, `booking_details`, `adapter_receipts`, `partition_meta`, `closures`, `__adapter_meta`, `__adapter_outbox`, and `__attribution` when present, in stable primary-key order, plus the retention alarm. Absence differs from an empty table.

The attempted creation uses existing `DayCreateInput`; the command is byte-for-byte identical across failure, retry, and replay. Public creates stay pending; owner creates stay approved and retain the acting identity. One committed calendar create event is allowed; LINE create events remain absent. Replay leaves every captured value unchanged.
