# How to Reactivate a Legacy List via BlastEME

Diff a legacy CSV against SEME, isolate active recipients without confirmed hard delivery, and send the safe cohort through BlastEME.

## Safety model

- SEME is the source of truth for users, suppressions, cooldowns, and delivery events.
- BlastEME `sent_count` means SendGrid accepted the handoff; it does not prove delivery.
- A hard-delivered user has an `email_logs` row whose status is `delivered`, `opened`, or `clicked`, or whose metadata contains `delivered_at`.
- Until the return-path DNS problem is fixed, send only the verified webmail providers listed below.
- Seed-test new templates and deal content before sending to a real cohort.

## Required Cloud Shell environment

Do not store production secrets in this repository.

```bash
export SEME_DATABASE_URL='PASTE_THE_CURRENT_RAILWAY_POSTGRES_URL_FROM_RAILWAY'
export BLASTEME_BASE_URL='https://blasteme26-production.up.railway.app'
export BLASTEME_ADMIN_SECRET='PASTE_THE_CURRENT_ADMIN_SECRET_FROM_RAILWAY'
export BLASTEME_TEMPLATE_ID='PASTE_THE_VERIFIED_SENDGRID_TEMPLATE_ID'
```

**READ ONLY — confirms the required variables are set without printing their values.**

```bash
for name in SEME_DATABASE_URL BLASTEME_BASE_URL BLASTEME_ADMIN_SECRET BLASTEME_TEMPLATE_ID; do
  if [ -n "${!name:-}" ]; then
    echo "$name: SET"
  else
    echo "$name: MISSING"
  fi
done
```

## 1. Extract and normalize the CSV emails

First inspect the CSV header and confirm which column contains the email address. Do not assume it is column 2.

**READ ONLY — prints the CSV header.**

```bash
CSV_PATH='PASTE_THE_FULL_CLOUD_SHELL_CSV_PATH'
head -1 "$CSV_PATH"
```

For simple CSV files where the verified email column is column 2:

**READ ONLY — creates a normalized, deduplicated temporary email list.**

```bash
tail -n +2 "$CSV_PATH" | cut -d',' -f2 \
  | tr '[:upper:]' '[:lower:]' \
  | sed 's/^[[:space:]"'"']*//; s/[[:space:]"'"']*$//' \
  | grep -E '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' \
  | sort -u > /tmp/legacy_list_emails.txt
wc -l /tmp/legacy_list_emails.txt
```

For CSVs containing quoted commas or a different email column, use a CSV-aware parser instead of `cut`.

## 2. Diff the list against SEME

This query reports:

- total unique CSV emails;
- emails absent from SEME;
- active and sendable emails;
- already hard-delivered emails within the active/sendable cohort;
- active/sendable emails that are not yet hard-delivered.

**READ ONLY — imports into a temporary table and returns cohort counts.**

```bash
psql "$SEME_DATABASE_URL" -P pager=off <<'SQL'
CREATE TEMP TABLE imp (email text PRIMARY KEY);
\copy imp FROM '/tmp/legacy_list_emails.txt'

WITH matched AS (
  SELECT u.id, LOWER(u.email) AS email
  FROM imp l
  JOIN users u ON LOWER(u.email) = l.email
  WHERE u.status = 'active'
    AND NOT (
      COALESCE(u.tags, '{}'::text[]) &&
      ARRAY[
        'list-hard-bounce',
        'list-blocked',
        'list-suppressed',
        'list-unsubscribed',
        'list-spam',
        'list-suspected-bot-engagement'
      ]::text[]
    )
    AND NOT EXISTS (
      SELECT 1
      FROM suppression_list s
      WHERE LOWER(s.email) = l.email
    )
), classified AS (
  SELECT
    m.id,
    m.email,
    EXISTS (
      SELECT 1
      FROM email_logs el
      WHERE el.user_id = m.id
        AND (
          el.status IN ('delivered', 'opened', 'clicked')
          OR el.metadata ? 'delivered_at'
        )
    ) AS hard_delivered
  FROM matched m
)
SELECT
  (SELECT COUNT(*) FROM imp) AS csv_total,
  (SELECT COUNT(*) FROM imp l
    WHERE NOT EXISTS (
      SELECT 1 FROM users u WHERE LOWER(u.email) = l.email
    )) AS not_in_seme,
  (SELECT COUNT(*) FROM classified) AS active_sendable,
  (SELECT COUNT(*) FROM classified WHERE hard_delivered) AS hard_delivered,
  (SELECT COUNT(*) FROM classified WHERE NOT hard_delivered) AS not_yet_hard_delivered;
SQL
```

## 3. Bucket the not-yet-hard-delivered cohort by domain class

**READ ONLY — shows which domains are suitable for the first send.**

```bash
psql "$SEME_DATABASE_URL" -P pager=off <<'SQL'
CREATE TEMP TABLE imp (email text PRIMARY KEY);
\copy imp FROM '/tmp/legacy_list_emails.txt'

WITH eligible AS (
  SELECT u.id, LOWER(u.email) AS email
  FROM imp l
  JOIN users u ON LOWER(u.email) = l.email
  WHERE u.status = 'active'
    AND NOT (
      COALESCE(u.tags, '{}'::text[]) &&
      ARRAY[
        'list-hard-bounce',
        'list-blocked',
        'list-suppressed',
        'list-unsubscribed',
        'list-spam',
        'list-suspected-bot-engagement'
      ]::text[]
    )
    AND NOT EXISTS (
      SELECT 1 FROM suppression_list s WHERE LOWER(s.email) = l.email
    )
    AND NOT EXISTS (
      SELECT 1
      FROM email_logs el
      WHERE el.user_id = u.id
        AND (
          el.status IN ('delivered', 'opened', 'clicked')
          OR el.metadata ? 'delivered_at'
        )
    )
)
SELECT
  CASE
    WHEN LOWER(SPLIT_PART(email, '@', 2)) IN (
      'gmail.com', 'yahoo.com', 'hotmail.com', 'aol.com',
      'outlook.com', 'live.com', 'msn.com', 'ymail.com', 'rocketmail.com'
    ) THEN 'webmail_safe'
    WHEN LOWER(SPLIT_PART(email, '@', 2)) IN (
      'comcast.net', 'optonline.net', 'me.com', 'icloud.com',
      'att.net', 'verizon.net', 'sbcglobal.net'
    ) THEN 'isp_dns_reject'
    WHEN LOWER(email) LIKE '%.edu' THEN 'edu'
    WHEN LOWER(email) LIKE '%.gov' THEN 'gov'
    ELSE 'corporate_or_foreign'
  END AS domain_class,
  COUNT(*)
FROM eligible
GROUP BY 1
ORDER BY COUNT(*) DESC;
SQL
```

Current operating rule:

- `webmail_safe`: eligible for a watched send;
- `isp_dns_reject`: skip until return-path DNS is fixed;
- `edu` and `gov`: isolate into separate small watched runs;
- `corporate_or_foreign`: do not include in the webmail run.

## 4. Create missing webmail users and tag the target cohort

Choose a unique tag before running the write. Example format:

```bash
export LEGACY_TARGET_TAG='LIST-BE-REACTIVATE-YYYY-MM-DD-DESCRIPTION'
```

**READ ONLY — confirms the tag is non-empty.**

```bash
printf 'LEGACY_TARGET_TAG=%s\n' "$LEGACY_TARGET_TAG"
```

**LIVE WRITE / NO SEND — creates missing webmail users and tags only active, unsuppressed, not-yet-hard-delivered webmail users.**

```bash
psql "$SEME_DATABASE_URL" -v target_tag="$LEGACY_TARGET_TAG" -P pager=off <<'SQL'
CREATE TEMP TABLE imp (email text PRIMARY KEY);
\copy imp FROM '/tmp/legacy_list_emails.txt'

INSERT INTO users (email, status, tags)
SELECT
  l.email,
  'active',
  ARRAY[:'target_tag']::text[]
FROM imp l
WHERE NOT EXISTS (
    SELECT 1 FROM users u WHERE LOWER(u.email) = l.email
  )
  AND LOWER(SPLIT_PART(l.email, '@', 2)) IN (
    'gmail.com', 'yahoo.com', 'hotmail.com', 'aol.com',
    'outlook.com', 'live.com', 'msn.com', 'ymail.com', 'rocketmail.com'
  )
ON CONFLICT (email) DO NOTHING;

UPDATE users u
SET
  tags = array_append(COALESCE(u.tags, '{}'::text[]), :'target_tag'),
  updated_at = NOW()
WHERE LOWER(u.email) IN (SELECT email FROM imp)
  AND u.status = 'active'
  AND LOWER(SPLIT_PART(u.email, '@', 2)) IN (
    'gmail.com', 'yahoo.com', 'hotmail.com', 'aol.com',
    'outlook.com', 'live.com', 'msn.com', 'ymail.com', 'rocketmail.com'
  )
  AND NOT (
    COALESCE(u.tags, '{}'::text[]) &&
    ARRAY[
      'list-hard-bounce',
      'list-blocked',
      'list-suppressed',
      'list-unsubscribed',
      'list-spam',
      'list-suspected-bot-engagement'
    ]::text[]
  )
  AND NOT EXISTS (
    SELECT 1 FROM suppression_list s WHERE LOWER(s.email) = LOWER(u.email)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM email_logs el
    WHERE el.user_id = u.id
      AND (
        el.status IN ('delivered', 'opened', 'clicked')
        OR el.metadata ? 'delivered_at'
      )
  )
  AND NOT (:'target_tag' = ANY(COALESCE(u.tags, '{}'::text[])));

SELECT COUNT(*) AS tagged_cohort
FROM users
WHERE :'target_tag' = ANY(COALESCE(tags, '{}'::text[]));
SQL
```

## 5. Build the payload and create the run

Create a JSON payload containing the verified target tag, template ID, subject, curated deal slots, batch size, delay, bounce ceiling, and recipient cap.

**READ ONLY / NO SEND — validates the payload file.**

```bash
PAYLOAD_PATH='PASTE_THE_FULL_PAYLOAD_JSON_PATH'
python3 -m json.tool "$PAYLOAD_PATH" >/dev/null && echo 'JSON VALID'
```

**LIVE WRITE / NO SEND — creates a BlastEME run but does not start sending.**

```bash
RUN=$(curl -sS --max-time 60 -X POST "$BLASTEME_BASE_URL/api/bulk/runs" \
  -H "x-admin-secret: $BLASTEME_ADMIN_SECRET" \
  -H 'Content-Type: application/json' \
  --data @"$PAYLOAD_PATH" \
  | python3 -c "import json,sys; data=json.load(sys.stdin); print(data.get('run',{}).get('id',''))")
printf 'RUN=%s\n' "$RUN"
```

**READ ONLY / NO SEND — fails safely if the create response did not return a run ID.**

```bash
if [ -z "$RUN" ]; then
  echo 'RUN ID MISSING — inspect the create response before continuing'
else
  echo 'RUN ID PRESENT'
fi
```

## 6. Dry-run before sending

**READ ONLY / NO SEND — previews candidates and provider mix.**

```bash
curl -sS --max-time 90 -X POST "$BLASTEME_BASE_URL/api/bulk/runs/$RUN/dry-run" \
  -H "x-admin-secret: $BLASTEME_ADMIN_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"limit":50}'
echo
```

Confirm the sample and `domain_mix` contain only the intended domains.

## 7. Start the run

Production sending also requires `BLASTEME_ALLOW_PROD_SEND=true` in Railway.

**LIVE SEND — starts the verified BlastEME run.**

```bash
curl -sS --max-time 60 -X POST "$BLASTEME_BASE_URL/api/bulk/runs/$RUN/start" \
  -H "x-admin-secret: $BLASTEME_ADMIN_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{}'
```

## 8. Monitor delivery truth in SEME

**READ ONLY — shows confirmed event statuses for the current run.**

```bash
psql "$SEME_DATABASE_URL" -P pager=off -v run_id="$RUN" -c "
SELECT status, COUNT(*)
FROM email_logs
WHERE metadata->>'blasteme_campaign_id' = :'run_id'
GROUP BY status
ORDER BY COUNT(*) DESC;"
```

Healthy webmail sends should remain below the configured bounce/block ceiling. Investigate any spike by provider rather than assuming the entire legacy list is bad.

**READ ONLY — groups blocked events by provider.**

```bash
psql "$SEME_DATABASE_URL" -P pager=off -v run_id="$RUN" -c "
SELECT LOWER(SPLIT_PART(u.email, '@', 2)) AS provider, COUNT(*) AS blocked
FROM email_logs el
JOIN users u ON u.id = el.user_id
WHERE el.metadata->>'blasteme_campaign_id' = :'run_id'
  AND el.status = 'blocked'
GROUP BY 1
ORDER BY blocked DESC;"
```

## Emergency stop

**LIVE WRITE / NO SEND — requests that BlastEME stop the run between batches.**

```bash
curl -sS --max-time 60 -X POST "$BLASTEME_BASE_URL/api/bulk/runs/$RUN/stop" \
  -H "x-admin-secret: $BLASTEME_ADMIN_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{}'
```

## After the run

1. Re-run the SEME hard-delivery metrics and record net-new hard-delivered users.
2. Keep bounce, complaint, unsubscribe, and suppression outcomes excluded from future sends.
3. Disable `BLASTEME_ALLOW_PROD_SEND` between sending sessions.
4. Fix return-path DNS before retrying the ISP/Apple cohort.
