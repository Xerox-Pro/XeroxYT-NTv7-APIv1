# Social session security review — 2026-11-12

Scope: local source review of social API authentication, credential storage,
upstream requests and draft unofficial-session adapters. This is not a penetration
test or evidence that any real account has or has not been compromised.

## Verified protections

- The social API checks allowed Origin and an active site session before private operations.
- User/service-specific credential records use the existing AES-256-GCM vault,
  with the record key as authenticated additional data. API status responses omit secrets.
- Unofficial authenticated requests use fixed HTTPS platform hosts and reject redirects.
  Cursor and thread inputs cannot select credential destinations.
- Cookie input uses a per-service name allowlist and excludes header control characters.
- Oversized request and upstream bodies are stopped while streaming.
- No third-party unofficial library is installed or executed. The protobuf runtime
  is an existing dependency; messaging field layouts were researched separately.
- Provider challenges fail closed; unsupported reads do not enable capabilities.
- Sending requires explicit authenticated POST; uncertain acknowledgements are errors.
  The draft route reserves a per-user client ID to prevent automatic duplicate sends.

## Residual risks and release status

A session cookie is a reusable login credential, even when no password is supplied.
Leaking it can permit account impersonation. Encryption at rest does not protect
against a compromised application server, exposed encryption key or site session,
malicious browser extensions, or XSS acting as the logged-in user. Existing shared
vault key compromise would affect connected credentials; no key rotation was done.

The draft unofficial adapters are behind SOCIAL_UNOFFICIAL_ENABLED, which is off
by default and remains off in production. The connection UI is unfinished. Do not describe them as production-ready or account-verified.
Disconnecting locally deletes the saved copy but does not invalidate a copied cookie
at the platform. Users must end the corresponding session in the official service
if compromise is suspected. Two-factor authentication helps protect new logins but
does not make an already exposed session harmless.

Neither real account login history nor production credentials were inspected.
No real DM was sent. Unofficial access can trigger platform challenges or account
restrictions independently of credential theft. No guarantee of zero risk is made.

## Validation

All 66 API tests passed, including session security and production hardening tests. Worker build
passed. New tests cover cookie filtering, fixed destinations/no redirects,
stream limits, encrypted record isolation/tamper detection, challenge rejection,
and validation/acknowledgement of DM sends. They do not verify provider interoperability.

## Production hardening follow-up

- Strict ticket expiry/session type validation; active-session revocation remains required.
- Account JSON parsing uses streaming limits and rejects malformed JSON without logging bodies.
- API responses include no-sniff, frame denial, no-referrer and restrictive CSP headers.
- Frontend shell restricts script sources/inline handlers, objects, base URLs and framing.
  Dedicated playback routes are excluded to preserve existing embedded playback.
- New service namespaces are rejected by the Vercel gateway; browser API transport remains
  direct to Cloudflare. Unofficial import attempts are separately throttled.
- Frontend has 33 passing targeted regression/security tests and a successful TypeScript
  check/build. API production dependency audit reported zero known vulnerabilities.
- No database migration, user data deletion, session invalidation or vault key rotation.
