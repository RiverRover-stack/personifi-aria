# GSoC 2026 — Persistent & Scheduled Firmware Upgrades
**OpenWISP Firmware Upgrader · Status State Machines · Aditya Shandilya**

> **New statuses introduced by this project:**
> - `waiting` *(NEW)* on `UpgradeOperation` — device was offline at upgrade time, persistent retry pending
> - `scheduled` *(NEW)* and `cancelled` *(NEW)* on `BatchUpgradeOperation`
>
> All other statuses (`queued`, `in-progress`, `success`, `failed`, `aborted`) are existing.
> The `waiting` badge label is pending UX review by the OpenWISP team (per [GSoC Discussion: Persistent & Scheduled Upgrades Clarifications #1249](https://github.com/openwisp/openwisp-firmware-upgrader/discussions/1249)).

---

## 1. BatchUpgradeOperation — Lifecycle State Machine

```mermaid
stateDiagram-v2
    direction LR

    [*] --> scheduled : created with scheduled_at set
    [*] --> in_progress : created with no scheduled_at

    scheduled --> in_progress : Celery Beat sweep every 60s\nscheduled_at reached\nRe-validates targets & permissions
    scheduled --> cancelled : Admin list action: Cancel scheduled upgrade

    in_progress --> success : All UpgradeOperations resolved
    in_progress --> failed : Permanent failures exist\nno ops in waiting state

    note right of in_progress
        In persistent mode, batch stays in-progress
        while any device ops are in waiting state.
        Org admins notified every 14 days (configurable).
        Admins can cancel remaining devices manually.
    end note

    cancelled --> [*]
    success --> [*]
    failed --> [*]
```

---

## 2. UpgradeOperation — Per-Device Lifecycle State Machine

```mermaid
stateDiagram-v2
    direction LR

    [*] --> queued
    queued --> in_progress : Upgrade task dispatched

    in_progress --> success : Device upgraded & reconnected OK
    in_progress --> failed : Permanent failure\n(cannot reconnect after upgrade)
    in_progress --> waiting : Device offline at upgrade time\nAND batch.persistent = True
    in_progress --> aborted : Manually aborted

    waiting --> queued : health_status_changed signal (openwisp-monitoring)\nOR Celery Beat sweep every 10 min\nBackoff: 5 min × 2^retry_count, cap 12h, ±20% jitter\nRedis lock on device_id prevents duplicate retries

    note right of waiting
        retry_count and next_retry_at tracked on UpgradeOperation.
        No automatic cancellation — admin must cancel manually.
        Shown in admin as "Pending retry at HH:MM".
    end note

    success --> [*]
    failed --> [*]
    aborted --> [*]
```

---

## 3. Combined End-to-End Flow (Features 1 + 2)

```mermaid
flowchart TD
    A([Admin creates BatchUpgradeOperation]) --> B{scheduled_at set?}

    B -- No / Feature 1 only --> C[Batch: in-progress\nUpgrade tasks fire immediately]
    B -- Yes / Feature 2 --> D[Batch: scheduled]

    D -- Celery Beat fires every 60s\nscheduled_at reached --> C
    D -- Admin cancels --> CANCEL([Batch: cancelled])

    C --> F[For each device:\nUpgradeOperation queued]
    F --> G{Device online at upgrade time?}

    G -- Yes --> H[UpgradeOperation: in-progress]
    G -- No + batch.persistent = True --> WAIT[UpgradeOperation: waiting\nretry_count incremented\nnext_retry_at set with backoff]

    H --> J{Upgrade result}
    J -- Device reconnects OK --> K([UpgradeOperation: success])
    J -- Cannot reconnect after upgrade --> L([UpgradeOperation: failed])

    WAIT -- health_status_changed signal\nOR Celery Beat sweep --> H

    K & L --> N{All ops resolved?}
    N -- Yes, some permanent failures --> BFAIL([Batch: failed])
    N -- Yes, all succeeded --> BSUCCESS([Batch: success])
    N -- No, some ops still in waiting --> STILL[Batch stays: in-progress\nNotification sent every 14 days]
    STILL --> WAIT
```

---

**References:**
- [[feature] Persistent mass upgrades #379](https://github.com/openwisp/openwisp-firmware-upgrader/issues/379)
- [[feature] Scheduled mass upgrades #380](https://github.com/openwisp/openwisp-firmware-upgrader/issues/380)
- [Prototype PR: GSoC 2026 Prototype — Persistent & Scheduled Firmware Upgrades #1](https://github.com/Adityashandilya555/openwisp-firmware-upgrader/pull/1)
