# Fit-Rend-Base

Your own repos, deploys and databases on one server, with clearance levels and 2-step sign-in.

- Fit room (repos): files, history, restore, zip download, saved keys and values
- Rend room (deploys): owner only. The door asks for a fresh 2-step code and locks again when you leave. Share links (public, key link, or owner only), expiry, QR codes, rollback, deploy hooks
- Base room (database): one Postgres database per project, SQL runner, tables, policies (RLS), REST API with public and service keys, allowed websites (CORS)
- Contacts: people, tags, CSV import and export, email campaigns sent through LeadReplyRadar's Gmail
- Handover room: keys and values other apps need (link secrets, webhook secrets, deploy hook addresses, database keys, AI keys). Own clearance level; each look is logged
- Connectors: saved API keys, signed webhooks out, deploy hooks in
- Admin: users, clearance levels per room, per-item access, AI access (keys that reach only the Fit room and the Base room), audit log, settings, backups

Key boxes: double tap to make bigger, tap again to make small, the eye shows or hides, Generate makes a strong new key.

AI access: POST /api with headers `X-CC: 1` and `Authorization: Bearer frbai_...`. Allowed actions: repoList, repoCreate, fileList, fileGet, commit, history, projectList, projectApi, dbTables, dbTable, dbQuery, dbPolicies, me. Everything else is refused and logged.

Install: paste `oracle-setup.sh` into a new Oracle Cloud server's initialization script.
Runs anywhere Docker runs (Oracle, AWS, any Linux server): `docker compose up -d --build` with a `.env` holding POSTGRES_PASSWORD, APP_SECRET and DOMAIN.
