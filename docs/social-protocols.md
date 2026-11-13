# Social protocol research attribution

The TikTok messaging field layout was researched from the public MIT-licensed
[etrnkz/tiktok-unofficial-api](https://github.com/etrnkz/tiktok-unofficial-api).
Only protocol field layouts were used. Captured account cookies, device identities,
anti-bot token generators and challenge bypass logic are not included.
Real-account interoperability has not been verified.

## Upstream license

MIT License

Copyright (c) 2026 TikTok Unofficial API Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Instagram interactions (2026-11-13)

Search, comment, like/unlike and personal note request fields were checked against
[subzeroid/instagrapi](https://github.com/subzeroid/instagrapi), specifically
`mixins/fbsearch.py`, `mixins/comment.py`, `mixins/media.py` and `mixins/note.py`.
These adapters implement protocol requests independently; no signing code or
challenge bypass is included. Notes explicitly select audience 0 (mutual
followers) or 1 (close friends). They require a provider acknowledgement before
reporting success. No real-account write test was performed.

The consent-gated session import is controlled by `SOCIAL_UNOFFICIAL_ENABLED`.
Connection probes never send messages, likes, comments or notes. Write adapter
availability is not proof that a live provider accepts that operation.
Mutations share an account/service-scoped one-time client ID claim. Client code
must not automatically retry an uncertain result. Disconnect removes unofficial
credentials as well as official OAuth credentials. This does not invalidate the
provider's browser session; the account owner can revoke it in the official app.

## TikTok feed / search / interactions (2026-11-13)

For You batch semantics, following request fields and search response variants
were checked against the endpoint declarations in
[caixax/opentok](https://github.com/caixax/opentok) and search/trending interfaces in
[davidteather/TikTok-Api](https://github.com/davidteather/TikTok-Api).
No browser fingerprint modification, signing algorithm or challenge bypass was
imported. Providers can reject direct server requests. Empty/invalid responses
fail closed instead of fabricating content or retrying in a loop.

For You requests return fresh batches; following uses its own provider cursor.
The frontend stops automatic pagination if an append contains no new IDs.
Video search accepts item_list; user search accepts user_list[].user_info.
Account identity accepts user_id_str before a numeric user_id to preserve IDs.
TikTok likes/comment writes use POST with an empty form body and the user's own
session tt_csrf_token header. Missing CSRF prevents writes before network I/O.
These adapters are verified with mocked responses only, not real accounts.
