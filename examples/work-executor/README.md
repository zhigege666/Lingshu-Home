# Reference HTTP work executor

This standalone service connects Home's work-execution protocol to one trusted command fixed at startup. It uses Python 3.10+ and the standard library on Linux/POSIX. It is not started by Home and adds no dependency to an unused Home installation.

1. **User experience.** Home can show the real process receipt and its bounded output. An unknown receipt requires checking the original run; it is not a successful execution.
2. **Developer experience.** A SQLite database preserves request identity and outcomes. The configured argv is immutable for the lifetime of the service, and task data is delivered only as JSON on stdin.
3. **AI Agent experience.** Reuse the Home run ID as Idempotency-Key, read the receipt after an uncertain response, and keep payloads stable. Repeating an existing ID never starts another command.

## Start

Choose an RFC1918 IPv4 or ULA IPv6 address already assigned to the executor host. Home's private HTTP executor contract rejects loopback, wildcard and public addresses. The example also requires an explicit private bind address.

From the repository root, create a new private state directory and command configuration:

~~~sh
python3 - <<'PY'
from pathlib import Path
import json, secrets, sys
state = Path("var/work-executor")
state.mkdir(mode=0o700, parents=True, exist_ok=False)
token = state / "token"
token.write_text(secrets.token_urlsafe(32) + "\n")
token.chmod(0o600)
command = [sys.executable, str(Path("examples/work-executor/sample_task.py").resolve())]
(state / "argv.json").write_text(json.dumps(command) + "\n")
PY

python3 examples/work-executor/executor.py \
  --bind 192.168.1.10 --port 8788 \
  --data-dir var/work-executor \
  --token-file var/work-executor/token \
  --argv-file var/work-executor/argv.json \
  --timeout 60 --workers 2
~~~

Replace the bind address with an address on your executor host. Configure Home's endpoint as http://192.168.1.10:8788 and supply the token from the private token file. The token is never printed by this service. The optional --ready-file writes only the selected endpoint and PID; --port 0 selects a temporary port for isolated tests.

sample_task.py performs a real Python subprocess invocation that reads the supplied snapshot and returns an acknowledgement. It does not synchronize an external business system. Replace the fixed argv with your own trusted program to perform that work; optional --working-directory is also fixed at startup.

The command runs with the executor user's operating-system permissions. This example is not a sandbox. It never uses a shell, interpolates task text, adds payload fields to argv, or turns text into environment variables. A configured program must itself treat its stdin as data.

## Protocol

Every response from the two protocol handlers has exactly four fields:

~~~json
{"id":"0123456789abcdef0123456789abcdef","state":"running","result":"","message":""}
~~~

All four values are strings. States are running, succeeded, failed and unknown.

### POST /runs

Require Authorization: Bearer TOKEN, Content-Type: application/json, Idempotency-Key equal to the body's lowercase 32-hex id, and a bounded Content-Length.

~~~json
{
  "id":"0123456789abcdef0123456789abcdef",
  "item":{"id":"fedcba9876543210fedcba9876543210","title":"Read this snapshot"},
  "event":{"kind":"item.created"}
}
~~~

item and optional event must be objects. They are read-only snapshots from Home; this service neither changes Home's item nor obtains permission to mutate it. Request bodies are limited to 1 MiB. Unknown top-level fields and duplicate JSON keys are rejected.

| Status | Meaning |
|---|---|
| 202 | A new ID was durably accepted; the returned receipt may already be terminal. |
| 200 | Same ID and canonical JSON content; return the existing receipt without a second execution. |
| 409 | The ID belongs to different content; the original receipt is unchanged. |
| 400 | Invalid body or idempotency header. |
| 401 | Missing or invalid bearer token. |
| 429 | All fixed command slots are occupied; the new ID was not stored or executed. |
| 503 | Acceptance/storage could not be confirmed; inspect the original ID. |

Object-key order and JSON whitespace do not change the stored request hash. A new executor configuration affects new IDs; it does not invalidate earlier receipts.

### GET /runs/{HomeID}

Return 200 with the current receipt, 404 when that ID was never accepted, or 401 without valid authentication. GET and POST use the same bearer token.

stdout becomes result, limited to 4,000 Unicode characters. message contains the observed exit status and bounded stderr, at most 1,000 Unicode characters. Excess output is drained and discarded, with an explicit truncation marker; it is not accumulated in memory or logs. The four-field JSON response stays below 64 KiB. Command output is persisted as receipt data, so configure commands that return appropriate result content.

## Durability, shutdown and uncertainty

A single process owns each receipt database. The database stores the canonical request hash and receipt, not the bearer token or request snapshot. Preserve the data directory across restarts; deleting it also deletes idempotency history.

On restart, existing running rows become unknown and are not executed again. A command may have performed work before the old process stopped. Successful subprocess exit is a receipt about the configured process, not proof that every separate business effect completed.

At the deadline or during shutdown, the service signals its still-live child's process group and records unknown. It does not claim to stop escaped descendants, remote jobs or external effects. Unknown runs are never automatically retried. The operator should inspect the original run and effects before authorizing new work.

There is no background SQLite polling, receipt pruning or automatic retry loop. The standard-library HTTP listener remains active; command workers exist only for accepted runs.

## Validate

Tests create their own data directories, random bearer tokens, private-IP temporary ports and controlled subprocesses. Provide an RFC1918/ULA address assigned to the test host:

~~~sh
WORK_EXECUTOR_TEST_BIND=192.168.1.10 python3 -m unittest discover \
  -s examples/work-executor -p 'test_*.py' -v
~~~

Without that explicit test address, HTTP tests report a skip; this must not be reported as an executed end-to-end pass. Never point these tests at a running Home or executor data directory.
