# contingency-form-api

Railway-hosted Node.js/Express API serving as the backend for all NuHome web forms. Deployed at contingency-form-api-production.up.railway.app.

## Stack
- Node.js / Express
- multer (memoryStorage) for file uploads
- @supabase/supabase-js for file storage (always pass ws transport to createClient — required in Node 20 or WebSocket failures will occur)
- @anthropic-ai/sdk for AI damage report generation
- resend for transactional email
- axios for HubSpot API calls

## Environment Variables (set in Railway — never commit these)
- HUBSPOT_PRIVATE_APP_TOKEN
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY
- RESEND_API_KEY

## Endpoints
- POST /inspection — creates HubSpot contact + deal in Roofing Insurance pipeline (2476304118) at Site Inspection stage (4130205409), uploads photos to Supabase inspections bucket, generates AI damage report via Anthropic, emails stacy@thenuhome.com
- POST /submit — updates existing roofing insurance deal to Contingency Signed stage (4109489900)
- POST /scope — updates existing roofing insurance deal to Scope Received stage (4109489903)
- POST /retail-submission — creates HubSpot contact + deal in Roofing Retail pipeline (2477633213) at Intake stage (4106670802), uploads files to Supabase inspections bucket, emails misty@thenuhome.com and mariah@thenuhome.com
- POST /solar-submission — creates HubSpot contact + deal in Operations pipeline (1022523097) at Intake stage (1578819287), uploads files to Supabase solar bucket, emails misty@thenuhome.com and mariah@thenuhome.com
- GET /options/reps — fetches closer/setter enum options from HubSpot at runtime, 5-minute memory cache. No longer called by any frontend (solar-submission switched to free text inputs) but the cache is still used internally by /solar-submission enum matching — do not remove
- GET /rep-deals — rep-facing deal lookup by fuzzy name match against closer/setter fields
- POST /rep-deals/action — rep actions: note, adjuster, lost, retail
- GET /admin-deals — admin deal summary, requires x-admin-token header matching ADMIN_TOKEN env var
- POST /generate-pdf — generates inspection report PDF via pdfkit, uploads to Supabase
- GET /check-pdf — checks if inspection_pdf_url is populated on a HubSpot deal
- PATCH /update-deal-pdf — writes inspection_pdf_url to HubSpot deal

## Critical Rules
- NEVER write to HubSpot pipeline 1022523097 from any endpoint except /solar-submission
- /solar-submission is the sole authorized writer to the Operations pipeline — intentional exception, not a bug
- All other endpoints are permanently forbidden from touching pipeline 1022523097
- Never commit API keys — .gitignore must exist before git init or git add
- Always pass ws transport to Supabase createClient in Node 20 or uploads will fail silently
- File uploads: 90MB soft skip per file (log and skip, do not fail the request), 200MB total multer guard
- Enum fields: always fuzzy match at 0.6 threshold against live HubSpot values fetched at runtime — skip the field if no match, never let an enum mismatch fail a deal creation
- If a Railway deployment gets stuck indefinitely, delete the service and create a fresh one

## Fuzzy Matching
Uses a 12-line Dice-coefficient bigram scorer at 0.6 threshold. Applies to: closer, setter, battery, generac_generator, utility, adders, funding, financier, perfect_power_box. Skipped fields are logged in Railway and reported in the ops email skipped fields section so ops can manually correct in HubSpot.

## Supabase Buckets (project rfytaiowxtpmesqzoidz)
- inspections — roofing insurance inspection photos + retail submission files
- contingency — contingency form uploads
- scopes — scope documents
- solar — solar submission documents (utility bill, proposal, install agreement, site map, home photo)

## HubSpot Pipelines
- Customer Sales (solar/default): default pipeline
- Roofing Insurance: 2476304118
- Roofing Retail: 2477633213
- Operations: 1022523097 — protected, only /solar-submission may write here

## HubSpot Stage IDs (key ones)
- Roofing Insurance Site Inspection: 4130205409
- Roofing Insurance Contingency Signed: 4109489900
- Roofing Insurance Scope Received: 4109489903
- Roofing Retail Intake: 4106670802
- Operations Intake: 1578819287

## Email Recipients by Endpoint
- /inspection → stacy@thenuhome.com
- /submit → stacy@thenuhome.com
- /scope → stacy@thenuhome.com
- /retail-submission → misty@thenuhome.com, mariah@thenuhome.com
- /solar-submission → misty@thenuhome.com, mariah@thenuhome.com
All sent from noreply@thehiveoffice.com via Resend.
