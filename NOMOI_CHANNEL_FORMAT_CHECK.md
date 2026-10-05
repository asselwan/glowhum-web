# NOMOI channel format check

The canonical source is:

`/home/ainur/Apps/.ainur/physai/NOMOI_CHANNEL_FORMAT_GENSPARK_K3_2026_09_04.md`

Run the canonical check explicitly when that host document is available:

`node scripts/verify-nomoi-channel-format.mjs /home/ainur/Apps/.ainur/physai/NOMOI_CHANNEL_FORMAT_GENSPARK_K3_2026_09_04.md`

The unit tests read `test/fixtures/nomoi-channel-format.md` instead. That fixture copies selected passages verbatim from the canonical document (SHA-256 `f160f7dd451e8eae3259f8feaa972b2c11a812f4350d904b0ff45dcdab5e8f9c`); it is a test sample, not a substitute for canonical verification or founder delivery. To check a canonical document at a different location, pass its path as the CLI argument or set `NOMOI_CHANNEL_FORMAT_PATH`.

It checks THE RUN format, the founder role and shot list, the ASK to ACKNOWLEDGEMENT to REFINEMENT to RECEIPT formulation, the solo production kit, and three distinct episode briefs. It treats the source file as read only and reports its byte count and SHA 256 value.

The check does not claim founder approval, filming, or a real production run.

`GATE_REMAINING: FOUNDER_ACCEPTANCE_OR_REAL_RUN`
