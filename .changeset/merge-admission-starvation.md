---
"@runfusion/fusion": patch
---

summary: Reviews and merges no longer wait indefinitely behind a backlog of tasks waiting to be planned.
category: fix
dev: Merge admission provider is keyed by the working directory like the other lanes, and also advertises capacity-deferred merges (`wakeCapacityDeferredMerge`).
