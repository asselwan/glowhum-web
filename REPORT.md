# Glowhum order wait state

Added a real elapsed-time display beside the order tracker for the `rendering` state. It calculates time since `order.created_at`, updates every second, and clears when the status changes or an error appears. Added a quiet "Message us on WhatsApp" link in the same state, using the exact href from `index.html`.

Diff summary: `order.html` has 24 insertions and 1 deletion (the existing error handler now also hides the rendering-only content). The tracker, copy button, video link, other status copy, and existing hrefs are unchanged. No other page or server file was touched. `SCOPE.md` was already untracked before this work; this report is the only other file added.

Verification: `git diff --check` passed. A local JavaScript fixture passed for rendering, paid, published, refunded, and rendering-to-published behavior; it also confirmed the WhatsApp href exactly matches `index.html`. Headless Chrome exited in this environment before rendering a page, so a browser screenshot check was unavailable.
