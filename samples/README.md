# Samples

A small workspace for the extension's tests, and for trying the extension by
hand: open this folder in VS Code with kv-cli installed.

`test/fixtures/recorded/` holds what real kv-cli 0.14.0 printed for each file
here. After changing anything in this folder, record them again:

```bash
KV_CLI=/path/to/kv-cli npm run record-fixtures
```

| File | kv-cli 0.14.0 says |
| --- | --- |
| `deploy.py` | FAIL: 13 errors, 6 warnings (KV001, KV002) |
| `compliant.py` | PASS: clean, 3 functions enforced |
| `dbt_model.py` | clean, but nothing enforced: dbt owns the signature |
| `orders_job.py` | warnings only: KV003 and KV004 |
| `broken.py` | skipped: `syntax_error` |
| `dbt/models/unparsed.sql` | skipped: `sql_not_parsed` |
| `dbt/models/session.sql` | warnings only: KV003 in a dbt model |
| `config/pipeline.yml` | clean, credentials only |

`deploy.py`, `compliant.py`, `dbt_model.py` and `dbt/models/session.sql` are
copied from [kv-cli's samples](https://github.com/kovallent/kv-cli/tree/v0.14.0/samples)
(MIT). `.kovallent.yaml` is `kv-cli init`'s template with the example naming
rule turned on, so KV004 has something to report.

`deploy.py` holds fake credentials on purpose, as kv-cli's own sample does.
