WITH paid AS (
  SELECT document_id, SUM(amount)::bigint AS amount
  FROM account_entries
  WHERE type IN ('P', 'A')
  GROUP BY document_id
), paid_by_document AS (
  SELECT d.id, COALESCE(p.amount, 0)::bigint AS amount
  FROM documents d
  LEFT JOIN paid p ON p.document_id = d.id
)
UPDATE documents d
SET status = CASE
  WHEN p.amount = 0 THEN 'PENDING'::"document_status"
  WHEN p.amount < d.total_cents::bigint THEN 'PARTIAL'::"document_status"
  ELSE 'COMPLETED'::"document_status"
END
FROM paid_by_document p
WHERE p.id = d.id
  AND d.status <> 'CANCELLED';

ALTER TABLE documents ALTER COLUMN status SET DEFAULT 'PENDING';
