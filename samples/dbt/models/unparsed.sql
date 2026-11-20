-- No SQL dialect kv-cli tries parses this model, so it is read through its
-- tokens and listed in run.skipped as sql_not_parsed.
select order_id,
from {{ ref('stg_orders') }}
where (status = 'shipped'
