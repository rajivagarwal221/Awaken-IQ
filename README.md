# Awaken IQ

Marketing site, student and parent portal, and management console for [Awaken IQ](https://awakeniq.com), a Navi Mumbai centre offering Mid-Brain Activation, DMIT, QSR and wellness programs.

Parents browse courses, register a child, pay online and join live classes. Staff manage students, attendance and bulk imports from one dashboard.

## Features

- **Marketing pages** (`initial_*.html`): home, about, services, DMIT, QSR, gallery, blog and testimonials.
- **Enrolment flow**: course catalog, course detail pages, student and parent details, review, then payment.
- **Payments**: Razorpay checkout with server-side signature verification and a webhook for `payment.captured` / `order.paid`.
- **Student portal**: dashboard, my courses, attendance, feedback, and an embedded Zoom room for live classes.
- **Management console**: `ADMIN` (full access, Excel bulk import) and `STAFF` (day-to-day tools) roles.
- **Accounts**: login, forgot and reset password by email, rate-limited auth endpoints.

## Tech stack

| Layer | Tools |
| --- | --- |
| Frontend | Static HTML + per-page Tailwind CSS |
| Backend | Node.js, Express 5 |
| Database | PostgreSQL (Neon) via Prisma ORM |
| Payments | Razorpay |
| Storage | Google Drive (student folders, DMIT reports) |
| Rate limiting | Upstash Redis (optional) |
| Hosting | Vercel |

## Getting started

```bash
git clone https://github.com/rajivagarwal221/Awaken-IQ.git
cd Awaken-IQ
npm install                 # also runs prisma generate
cp .env.example .env        # fill in the values, see below
npm run db:migrate          # create tables
npm run db:seed             # default admin and staff accounts
npm run dev                 # http://localhost:8080
```

## Environment variables

All variables are listed with comments in [`.env.example`](.env.example). The important ones:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon / PostgreSQL connection string |
| `SESSION_SECRET`, `COOKIE_SECRET` | Random 32+ byte strings. `COOKIE_SECRET` signs login cookies and is required in production |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Management console login |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Payments |
| `GOOGLE_DRIVE_CREDENTIALS`, `DRIVE_PARENT_FOLDER_ID` | Student document storage |
| `SMTP_*`, `MAIL_FROM`, `APP_URL` | Password-reset emails |
| `ZOOM_SDK_KEY`, `ZOOM_SDK_SECRET` | Optional in-browser Zoom |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Optional shared rate limiting |

Never commit `.env`. In production, set these under **Vercel → Project → Settings → Environment Variables**.

## Project structure

```
frontend/            static pages, assets/css (generated), assets/js
backend/server.js    Express API (auth, enrolment, payments, admin)
backend/lib/         program catalogue and input validation
backend/test/        unit tests (node --test)
prisma/              schema, migrations, seed script
tailwind/            one Tailwind config per portal page
scripts/             build-tailwind.js
DESIGN.md            design tokens (colours, type, spacing)
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` | Run the API server |
| `npm run dev` | Run with file watching |
| `npm test` | Unit tests |
| `npm run db:migrate` | Apply Prisma migrations |
| `npm run db:seed` | Seed default admin and staff accounts |
| `npm run build:css` | Rebuild per-page Tailwind stylesheets |
| `npm run audit` | Check production dependencies for known vulnerabilities |

## Deployment

`vercel.json` deploys `backend/server.js` as a Node function and serves `frontend/` as static files, with security headers on every route. Push to `main` and Vercel builds automatically.
