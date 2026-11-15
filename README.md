# Water Rehabilitation Programme Management Dashboard

A management dashboard for tracking water rehabilitation projects across Oman —
project portfolio, financials, risks/issues, milestones, contractor performance,
and a full invoicing workflow generated from project cost statements.

## Requirements

- **Node.js 22.5 or newer** — check with `node -v`.
- **PostgreSQL** (tested with 18) and an empty database for the app, e.g.:

  ```sql
  CREATE USER nec_app WITH PASSWORD 'choose-a-password';
  CREATE DATABASE nec_dashboard OWNER nec_app;
  ```

## Setup

1. Copy `.env.example` to `.env` and set `DATABASE_URL`:

   ```
   DATABASE_URL=postgres://nec_app:choose-a-password@localhost:5432/nec_dashboard
   ```

   (A real environment variable of the same name works too, and takes priority.)

2. Install and start:

   ```bash
   npm install
   npm start
   ```

3. Open **http://localhost:3000**.

On start the app applies any pending database migrations (see below). It never adds demo
data by itself.

## Database migrations

Schema changes live in `db/migrations/` as numbered `.sql` files. Each file runs **once**,
in filename order, inside its own transaction, and is recorded in the `schema_migrations`
table.

- If a migration fails, it is rolled back completely and the app refuses to start until
  the migration is fixed.
- If two app processes start at the same time, only one of them applies the migrations.
- Pending migrations run automatically when the app starts. Run them by hand first when
  deploying, to see the result before starting the app:

```bash
npm run migrate -- --status   # list migrations: applied (with date) or PENDING
npm run migrate               # apply pending migrations
```

To make a schema change:

1. Run `npm run migration:new -- add-project-region`. This creates the next numbered file,
   e.g. `db/migrations/2026-10-01-002-add-project-region.sql`.
2. Write the SQL in that file, e.g. `ALTER TABLE projects ADD COLUMN IF NOT EXISTS region TEXT;`.
3. Deploy it with the code. Production applies it on its next `npm run migrate` or start.

Never edit a migration that has already been applied: the change would not run. `--status`
flags edited files. Add a new migration instead.

## Moving data from the old SQLite version

The app used to keep its data in `data/water-rehab.db` (SQLite). To copy that
into PostgreSQL once, with the app stopped:

```bash
npm run import-sqlite                          # imports data/water-rehab.db
npm run import-sqlite -- path/to/other.db      # or another SQLite file
```

- The SQLite file is only read, never changed.
- Every record keeps its id, so document numbers, links and the `uploads/`
  folders still match.
- It runs in one transaction: if anything fails, nothing is imported.
- It refuses to import into a database that already has data. Add `--replace`
  to wipe that data and import in its place.

## Other commands

| Command | What it does |
|---|---|
| `npm run migrate` | Applies pending migrations (`-- --status` to just list them). Safe on production. |
| `npm run migration:new -- name` | Creates the next numbered migration file. |
| `npm run seed` | Fills an **empty** database with demo data (37 sample projects…). Refuses if any project exists. |
| `npm run dev` | Starts with auto-restart on code changes. |

## Settings (`.env` or environment)

| Name | Default | |
|---|---|---|
| `DATABASE_URL` | — (required) | PostgreSQL connection |
| `PORT` | `3000` | Web port |
| `APP_USERNAME` / `APP_PASSWORD` | built-in defaults | Login — set these in production |
| `SESSION_SECRET` | built-in default | Set a long random value in production |
| `REPORT_SCHEDULER` | on | Set to `off` to stop scheduled reports from generating (useful on a test copy) |

## User accounts and approvals

**Sign-in.** The `APP_USERNAME` / `APP_PASSWORD` login is the *administrator*. Under
Administration → **User Accounts** the administrator can give any team member their own login
(username + a one-time temporary password, which the person must replace at first sign-in).
Passwords are stored hashed (scrypt), never in clear text; 5 wrong passwords lock an account for
15 minutes, and 30 failed sign-ins from one IP address block that address for 15 minutes.

**Access control.** Each login has one role, chosen by the administrator (User Accounts), and
everything not explicitly allowed is refused:

| Role | Can do |
|---|---|
| *Approver only* (default for new logins) | Open My Approvals and the specific documents assigned to them; sign their own step. Nothing else. |
| *Read only* | View the projects the administrator has granted them; change nothing. |
| *Project manager* | View and edit the projects granted to them (a project they create is granted automatically). Cannot manage master data, team members, accounts, the Activity Log or the Recycle Bin. |
| *Administrator* (`APP_USERNAME`/`APP_PASSWORD`) | Everything, including granting access. |

**Sequence of Events — by subcontractor, and actual ≤ planned.** The Sequence of Events tab has a List / By subcontractor switch: pick a subcontractor to see only its events on a timeline (planned vs actual bars, status colours, today marker) with its planned and actual value. An event belongs to a subcontractor through the Contractor on its Crew / Labour lines; value = those lines (materials are not tied to a subcontractor). An actual value may never exceed its planned value: material Consumed Qty ≤ Planned Qty, crew Actual Qty ≤ Planned Qty, project Actual Cost ≤ Approved Budget, VOWD cumulative work + variations ≤ Revised Contract Value. The field turns red with a message, a banner lists every offender, and saving is refused (browser and server). VOWD and Change Request forms show the chosen subcontractor's accumulated planned value from the Sequence of Events.

**Actual quantity by date.** Next to every Actual Qty (crew / labour) and Consumed Qty (material) field in the Sequence of Events there is a calendar button. It opens a pop-up where actual quantities are logged one dated entry at a time (date, quantity, note); the total is written into the field. Typing straight into the field still works: anything typed that is not backed by a dated entry shows in the pop-up as "entered directly". Entries cannot be future-dated and cannot take the total above the planned quantity; they are saved with Save Project (table `line_actual_entries`, migration 011) with who and when. The Excel template carries the totals, not the dated entries.

**Subcontractor Performance** (sidebar, replaces the old Contractor Performance page). Scores each subcontractor from data already in the dashboard — no new data entry and no database change. *On-time delivery* = events (linked through the Contractor column of their Crew / Labour lines) finished on or before the planned end date ÷ events due. *Cost adherence* = 60% variation growth (approved Subcontractor change requests ÷ contract base, the latest VOWD awarded value or else the planned crew / labour value) + 40% variation frequency. Quality, HSE and Responsiveness are shown as "not measured" because the system holds no NCR, HSE or RFI records; a KPI with no data is left out and its weight shared over the others, and an overall score needs at least two KPIs with data. Ratings: 80+ On target, 60–79 Watch, below 60 Action needed. The page has KPI cards, a ranked scorecard table (search, rating filter, sort, scoring period), radar, benchmarking, trend and timeliness charts, a per-subcontractor scorecard (deliverables, variations, contracts, trend), a benchmarking Excel export and a printable PDF scorecard / summary. All scoring rules live in `public/subcontractor-perf.js`, shared by the page, the PDF and the Excel export. Access follows the existing menu (`contractors`) and project grants; VOWD and change-request values are withheld from logins without view access to them. The "Base Performance" value in the Contractors master is no longer used.

**Risk Register / Issue Log: project filter and print preview.** Both pages have a Project dropdown (only projects that have records, with counts) that also drives the KPI cards, matrix / ageing chart and table, and combines with the tab and search. "Add risk" / "Add issue" starts on the filtered project. "Print preview" opens `register-print.html` (landscape A4, Print / Save as PDF) with exactly the rows listed, in the on-screen order, and the project / view / search filters named in the heading.

**Change request attachments.** Each change request has its own Attachments section. At least one supporting document is required before it can be submitted for approval, and the attachments are locked together with the request while it is pending or approved (withdraw or reopen to change them). Files uploaded under "Change Request" before this existed stay in an "Earlier change request files" list.

**Permission matrix (ACL).** Beyond the role, the administrator can give any Read only / Project
manager login its own matrix (User Accounts → *Permissions*): for each kind of record — Projects,
Risks, Issues, Milestones, Invoices, VOWD, Change requests, Certificates, Documents, Master data,
Team members — tick View / Create / Edit / Delete. Until customised, a login uses its role's template
(*Fill from* copies a template as a starting point). The matrix is enforced on the server for every
route; project records are also limited to the projects granted to the person. Assigning approvers or
submitting a document needs *Edit* on that kind of document; signing a document assigned to you never
needs a permission.

**Menu access.** For Read only and Project manager logins the administrator can also choose
which sidebar menus the person sees (User Accounts → *Menus*; default is every menu). Hidden menus
are removed from the screen and navigating to them is blocked. Risk Register / Risk Analytics, Issue
Log and Milestones also close the matching data on the server; the other menus show project data
that every project login already loads, so for those the restriction is on the screen only.

Role and project changes take effect within a minute (or at the person's next sign-in).
Programme-wide trend charts are aggregates and are not filtered by project.

**Approvals.** VOWD statements, change requests and completion certificates can be sent for
sign-off. In the document, choose who signs each signature block (only team members with a login
can be chosen), then **Submit for approval**.

- Approvers sign **in order**, each with their own login — from **My Approvals** or directly in the
  document's print preview. The shared administrator login cannot sign for anyone.
- While a document is awaiting approval, or once approved, it is **locked** (no edits, no delete).
  A rejection (reason required) returns it to its author; the author corrects it and resubmits.
  The submitter or the administrator can withdraw it; the administrator can reopen an approved
  document (reason required).
- A fully approved VOWD / certificate becomes *Issued*; a fully approved change request records
  the Change Control Board's *Approved* decision automatically.
- Every step (who, when, comment, IP address) is kept permanently and appears in the Activity Log;
  the printed document shows each approver's name, designation and an "Approved electronically"
  stamp with date and time.

## Project Progress

*Project Progress* in the sidebar: how far each project has actually advanced against the plan.

- **Cards:** actual vs planned %, schedule performance index (SPI), progress variance in days, activities finished in the
  chosen period (week / month / quarter) and the forecast completion date against the baseline.
- **Charts:** progress S-curve (planned, actual and — for several projects — budget-weighted earned), planned vs actual by
  project, progress by work package (project stage), slippage waterfall (days gained / lost month by month).
- **Look-ahead:** activities due to finish or start in the next 2, 3 or 4 weeks, with owner and status.
- **Exports:** *Measurement sheet* (Excel: planned vs actual for every activity, plus project, work-package, S-curve,
  slippage and look-ahead sheets); *Progress report* and *Slippage report* (PDF via the Report Library — weekly, monthly or
  quarterly, per project or combined).

How it is measured: each task is weighted by its planned duration; planned % is how much of the work the schedule says should
be finished today; SPI = actual ÷ planned; days ahead / behind use earned schedule (the date the plan had reached today's actual
%); the forecast carries the current pace to the end (planned duration ÷ SPI). Only today's progress is stored, so earlier points
of the S-curve and the waterfall are rebuilt from the recorded actual start / finish dates (an estimate; today is exact).
Tasks without a planned start and finish cannot be placed on the plan and are left out (the page says how many); a project with
no scheduled task is not measured. All of it lives in `public/progress-calc.js`, shared by the page, the sheet and the reports.
This planned % comes from the task schedule, so it differs from the calendar-based "Planned %" on the Project Portfolio, which
only measures time elapsed.

## Report Library

*Report Library* in the sidebar. Reports are worked out **on the server** and stored as a frozen copy, so
a report opened next month shows the numbers as they were on the day it was generated.

- **Catalogue** — ten standard reports: Executive portfolio summary (board pack), Monthly project progress,
  Slippage and recovery, Schedule and Gantt status, Financial / EVM and cost, Procurement and supply, Risk and issue, Contractor
  performance scorecards, Milestone / handover / closeout, Compliance and governance. One scope bar chooses
  business unit(s), project(s), project status, period and layout for whatever is generated next.
- **Builder** — tick sections from the same building blocks the standard reports use, order them, name the
  report, then generate, save (private or shared) or schedule it.
- **Scheduled** — daily / weekly / monthly at a chosen Oman time, with a relative period ("last month").
  The result goes to the recipients' **Inbox** (button at the top of the page) and to History. A schedule that
  was missed while the server was off runs once when it is back; it never runs the same slot twice. There is no
  e-mail delivery: that needs mail-server (SMTP) details, which this app does not have.
- **History** — every report ever generated, searchable by text, report, project, source and date; open it,
  download Excel, or *Run again* (same settings, today's data, saved as the next version).
- **Templates** — layouts: Standard, Board pack (cover, contents, page numbers), Compact. A report for one business
  unit carries that unit's name and logo (Master Data → Business Units); across several it carries NEC's.
  *Print / Save as PDF* uses the browser (A4 landscape); *Excel* has a Summary sheet plus one sheet per table.
- **Access log** (administrator) — who generated, opened, downloaded or printed what, and when. The same events
  are in the Activity Log (entity "Report").

Who sees what needs no new setup. A login can generate a report if it can open one of the report's pages
(Executive → Overview / Portfolio / Health, Finance → Financial Performance, and so on — the menus the administrator
already switches per login), and sees only its own projects. Sections whose data the login may not view are left out
and the report says so. A stored report can be opened only by a login that may see **all** of its projects and
every section in it; schedule recipients are checked the same way when the schedule is saved. To make an
Executive / Finance / PMO / PM role, set that login's menus and permissions as before.

Subsidiaries (AAMU, ECTRON, TadoomX, Zanzibar …) are the **business units** on each project: add the missing ones
under Master Data → Business Units and give their projects that unit. Amounts are added up as OMR — a subsidiary
reporting in another currency has to be converted first.

Limits worth knowing: milestones have no "completed" status, so overdue milestones are those whose date has
passed; there is no task-dependency data, so the schedule report lists late and imminent tasks rather than a calculated
critical path; Quality / HSE / responsiveness are not captured yet (contractor scorecards use delivery and cost).
The change is one migration (`2026-11-05-012-report-library.sql`, new tables only).

## Backups

Data is in PostgreSQL; uploaded files (documents, business-unit logos) are in
the `uploads/` folder. Back up both, e.g.:

```bash
pg_dump -Fc -d nec_dashboard -f nec_dashboard.dump
```
