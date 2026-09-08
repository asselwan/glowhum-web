# KADR provider check

TwoThumbs prompt `prm_a611c7ea-cec5-4831-970d-248073dff6fc`, version `112`.

## Decision

The saved fal slug is `fal-ai/bytedance/seedance/v1.5/pro/text-to-video`.

The saved preset is `kadr/presets/glowhum-clinic-offer.json`. It uses the Glowhum brand, 9:16, 720p, five seconds, audio, and a maximum budget of `$1.20`.

## Live result

The final live command ran the repository runner inside the existing Atlas container:

```
TWOTHUMBS_PROMPT_ID=prm_a611c7ea-cec5-4831-970d-248073dff6fc TWOTHUMBS_PROMPT_VERSION=112 node /tmp/kadr-render.mjs --preset /tmp/glowhum-clinic-offer.json --out /tmp/glowhum-kadr-clinic-offer.mp4
```

fal returned `COMPLETED` for request `01a07bf2-4d08-7cf0-8dd5-0f2d6989e854`.

The output is 5,469,077 bytes with SHA-256 `5d84e8f9d37f9ebc75a327f58a1efa0c1928b62f6a44289ffd4b1641dd79f5eb`. `ffprobe` found H.264 video at 720 by 1280, AAC audio at 44.1 kHz, and 5.05 seconds.

The receipt is `/tmp/glowhum-kadr-clinic-offer.mp4.receipt.json` with SHA-256 `57cfcf8efeb094a49a5c519cea712542c578540c1d814ac87d36e80baf7b909e`.

## Cost gate

The runner queried `https://api.fal.ai/v1/models/billing-events?request_id=01a07bf2-4d08-7cf0-8dd5-0f2d6989e854&limit=50`. fal returned HTTP `403`. The receipt records `billing_readback.status` as `unavailable`, `http_status` as `403`, and no actual cost. The provider page estimate of about `$0.26` is not used as actual spend.

## Checks

`node --test scripts/kadr-render.test.mjs` passed 3 of 3.

`node --check scripts/kadr-render.mjs` passed.

`git diff --check` passed.

Two earlier live requests failed truthfully. The first returned HTTP 422 because the REST body placed `prompt` inside `input`. The second returned HTTP 422 with `content_policy_violation` for the clinic wording. Neither produced an output file.

The independent K3 audit job `5634c23b-c0bf-4161-8315-30b79eba5f3a` returned `GO` for local completion. Its open items are measured fal cost and tamper evident registry signing. No commit was made. Existing changes to `server.mjs` and `delivery.mjs` remain untouched.
