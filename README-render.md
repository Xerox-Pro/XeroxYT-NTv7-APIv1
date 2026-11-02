# XeroxYT-NTv6 API — Render port

This branch ports the existing XeroxYT-NTv6 Express API to a standalone Render Node.js Web Service. It does **not** modify or deploy the Vercel frontend.

## Deployment

1. In Render, create a **private GitHub repository** Web Service from this repository and select branch `feature/render-v6-api` (or merge after review).
2. Use Node 22+, build command `npm install && npm run build`, start command `npm start`.
3. Configure `GEMINI_API_KEY`, `GITHUB_TOKEN`, `ENCRYPTION_KEY`, `LIMIT_SECRET` in Render's secret environment settings as needed. Do not commit credentials.
4. Verify `GET /` returns JSON and check authenticated API endpoints. `/api/health` is behind the existing account session middleware.
5. Route Vercel requests through a same-origin rewrite if you want to preserve session cookies. **Do not switch production traffic before checking account-session behavior, quotas, video APIs and streaming.**

The account middleware still validates against the existing Cloudflare account Worker. Requests must carry the correct session cookie. Free Render services can sleep and have bandwidth/compute limits. YouTube upstream restrictions may persist. This port has not yet been deployed or integration-tested.
