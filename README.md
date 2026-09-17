# Awaken-IQ

Marketing site + student/parent portal + management console for Awaken IQ.

- `frontend/` — static HTML (served directly by Vercel / Express).
- `backend/server.js` — Express API backed by Neon PostgreSQL via Prisma ORM.
- `prisma/` — Prisma schema (`schema.prisma`) and migrations.
- `tailwind/<page>.config.json` — each portal page's Tailwind theme.
- `frontend/assets/css/<page>.css` — generated stylesheets.

## Run locally

```bash
npm install
npm run start           # http://localhost:8080
```

## Features & Architecture

- **Datastore** — PostgreSQL (Neon cloud) + Prisma ORM.
- **Sessions & Auth** — Signed, HTTP-Only, SameSite=Lax cookie (`adminSessionToken`) backed by `admin_sessions` table in PostgreSQL.
- **Management & Staff Roles** — `ADMIN` (full access including Excel bulk import) and `STAFF` (operational tools access).
- **Student Database & Excel Import** — Centralized PostgreSQL database supporting dynamic registrations and admin Excel imports.
- **Payments** — Razorpay integration with signature verification.
- **Rate limiting** — Rate limiting on authentication and login endpoints.

## Scripts

| command | what |
| --- | --- |
| `npm start` | run the API server |
| `npm run dev` | run with file watching |
| `npm test` | unit tests |
| `npm run db:seed` | seed default admin and staff accounts |
| `npm run build:css` | rebuild per-page Tailwind stylesheets |
