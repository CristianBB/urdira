# Definitive agent benchmark results — reporting status

## Current v8 definitive campaign result

Status: **45 agent cells observed; 18 readiness attempts persisted with zero
successful probes** (2026-09-16). The three campaign audits contain
one sample for each of the 45 repository/task/arm identities. The additive
offline consolidation records 43 task-solved rows (target coverage 2/2 with
final changes present), 42 strict grader passes, two strict grader nonpasses,
and one infrastructure row with unavailable outcome evidence. The C3 VS
Code/Urdira row is task-solved and covered 2/2, but its strict grader reported
a tool-validation incident. The remaining unsolved row is the C1 VS
Code/codebase-memory execution-capacity failure at 0/2. The complete row index is embedded below and backed
by the external v8 consolidation Markdown at
`/Users/Cristian/BenchmarkResults/urdira-v8-derived-luna-campaigns-1-3-v1/summary/benchmark-campaigns-1-3-v3.md`
and JSON at
`/Users/Cristian/BenchmarkResults/urdira-v8-derived-luna-campaigns-1-3-v1/summary/benchmark-campaigns-1-3-v3.json`
(Markdown SHA-256 `030dcf4d92c954df9692655bee34676d0587aee3491d5e093ecb263660cb57a9`;
JSON SHA-256 `622be916d37ab86bcfe79f915b2e40652e5d7c3211e819e094946bdaddb4ce93`),
which retain all measured fields.

| Result set | Planned | Observed/started | Completed | Failed or blocked | Pending | Status |
|---|---:|---:|---:|---:|---:|---|
| Agent cells | 45 | 45 | 43 task-solved; 42 grader passes | 1 task unsolved + 1 infrastructure outcome unavailable; 2 strict grader nonpasses | 0 | complete as observed, with separated outcome axes |
| Readiness probes | 18 | 18 persisted attempts | 0 | 18 failed, blocked, or interrupted | 0 | complete with failures; not readiness-qualified |

The campaign separates task outcome, target coverage, execution, and strict
grader outcome. Forty-three rows are task-solved from complete target coverage
and retained final changes. The C3 VS Code/Urdira row is task-solved despite a
strict grader nonpass caused by the recorded tool-validation incident at
`/request/query`; this is not classified as a task-correctness failure. The C1
VS Code/codebase-memory row is an execution-capacity failure, and the C1
Prisma/Urdira row has unavailable task outcome evidence. Agent, runner, and
grader exit codes are retained separately. A configured Urdira arm is also
separate from observed tool use. Missing measurements are `null`, never zero.
The cost card is input/cached input `$2/M` and output/reasoning `$8/M`; input,
cached input, output, reasoning, and additive total remain separate measured
fields. Hook totals use `observed_tool_usage.urdira_hook_calls`, with served and
fallback counts separate; output-bearing hook calls are not substituted for
total invocations. Shell overlap is `null` when its source payload is
unavailable. P95 is `null`: three campaign samples do not meet the frozen
eligibility rule for a per-cell distribution.

The readiness measurement objective was not achieved. “Complete” for the
readiness row set means that 18 failed, blocked, or interrupted attempts were
persisted; it does not mean that readiness was measured successfully. The
post-campaign PATH fix is not retroactive validation and produced no new
readiness evidence.

The v8 source summaries are C1
`/Users/Cristian/BenchmarkResults/urdira-v8-derived-luna-c1-resume-v6d-v1/c1-summary-v4.json`
(SHA-256 `ae6fb0eaf943dd9fd9f93587a632c78a09718deaa8ab12513a32fffcc0f4795e`),
C2
`/Users/Cristian/BenchmarkResults/urdira-v8-derived-luna-c2-final-15-v1/c2-summary-final-v1.json`
(SHA-256 `54c61dbaaaa6a8c19dbcc3a3da8240edc4e355825fd3756e43a61cadb3ded2fd`),
and C3
`/Users/Cristian/BenchmarkResults/urdira-v8-derived-luna-c3-final-15-v3/summary/c3-summary-final-v2.json`
(SHA-256 `2dfe70e2734a18ad3ddda42082e64f5aafc09e41b2cf3854f79ac0e350dcb11b`).
The C3 composed audit is
`/Users/Cristian/BenchmarkCells/v8/campaign-3-resume-v6-after-c3-12-v1/campaign-audit-composed.json`
(SHA-256 `114e4a3a8d1f8f76176c779c90471dbe79c610dac84fcd6d449ed6f04db5b235`)
and its composed manifest SHA is
`4418db0a234dfeb9cd46dd986f27f84c23b57d43fa0408d53e6f5e537d305931`.

Readiness execution is complete with failures, but no probe achieved model
invocation. The retained readiness evidence records the prior cold socket and
dependency failures, the original Playwright and cancelled VS Code C2
interruptions, the C3 Playwright cold interruption (SIGTERM 143) with its warm
probe blocked, the C3 Prisma cold/warm pair blocked before model invocation by
the recorded frozen package-manager failure, and the C3 VS Code cold/warm pair
blocked by its recorded package-manager failure. In total 18 probes are
persisted as failed, blocked, or interrupted; no retry has been counted. The
latest audit is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/readiness-v8-resume-after-c1-playwright-v6/readiness-resume-audit.json`
(SHA-256 `fb239152b49a9296cd5980b0aec89802211a295afc668bbd450b9fee3a0110d5`).
The retained C3 Prisma pair is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/readiness-v8-resume-after-c1-playwright-v5/pair-prisma-3-status.json`
(SHA-256 `e6ae15cafa9b518e8125ec3267c9402c1882ed5911ccdbb3b9fde335e6850855`),
with cleanup evidence SHA-256
`f89d82adb28627ab471859817ace69137b515e4896f5819289efae1f0686c422`.

The retained C3 VS Code pair is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/readiness-v8-resume-after-c1-playwright-v6/pair-vscode-3-status.json`
(SHA-256 `cc11527d4faeb9bf6ce0cb10a92b6567b1bd53f63706ca95f32df7a67a2dbb9a`),
with cleanup evidence SHA-256
`90f8f17ffaacbd60f361b0c109e4893df05f459e0953cad63b6fb6a7fd916370`. The
complete readiness composition is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/readiness-final-composition-v1.json`
(SHA-256 `5a3be1432ac047084abdd24fbb4491c9219769c19683f4a51af06f5a616898a7`).
Readiness timestamps and storage/process/publication/freshness measurements remain
`null` unless present in a retained readiness artifact. This is a complete
readiness attempt record with no successful readiness result; it does not
qualify the benchmark as a successful readiness run.

The exact C3 VS Code/Urdira tool-validation incident and strict grader nonpass are retained in
`/Users/Cristian/BenchmarkResults/urdira-v8-derived-luna-c3-final-15-v3/summary/c3-15-grader-diagnostic-v1.json`
(SHA-256 `ce4db120b97bd4f038abebcd1930d8a0f530c7c9ff49642b76d6600da646e500`).
The raw transcript records `core:unknown_field` for `/request/query` on line
10; the agent exit was `0`, outer runner exit was `1`, and grader exit was
`1`, with target coverage 2/2. The task outcome is solved because the target
set and final changes are present; the strict grader is false because the
request used an unregistered field. This is a tool-validation incident, not a
task-correctness failure. No rm-f or test-blocked cause is attributed.
The external v8 consolidation JSON SHA is
`622be916d37ab86bcfe79f915b2e40652e5d7c3211e819e094946bdaddb4ce93`; its
Markdown SHA is
`030dcf4d92c954df9692655bee34676d0587aee3491d5e093ecb263660cb57a9`. The
append-only reporting-axis correction is
`/Users/Cristian/BenchmarkResults/urdira-v8-derived-luna-campaigns-1-3-v1/summary/benchmark-campaigns-1-3-v4-axis-correction.json`
(SHA-256 `e62bdc06fbf8c5cbb19ba6f1c28ded008e7d1df1f20e540d2bbede0ff94025e3`);
it leaves the v3 raw-derived consolidation unchanged and defines
`task_solved`, `grader_pass`, and `tool_validation_incident` separately.

### Supplemental C1 Prisma/Urdira recovery

The original C1 Prisma/Urdira row remains infrastructure-null in the strict
45-row table. An authorized same-identity supplemental recovery completed on
attempt 2; two pre-model recovery failures remain retained, followed by the
successful authorized recovery, and no retry was counted after the successful
model run. The supplemental row is a
separate recovery measurement and substitutes for the original null only in
the descriptive matrix in the append-only addendum below.

| identity | model | turns | task solved | target coverage | agent/runner/grader exit | setup ms | elapsed ms | input | cached input | output | reasoning | total | cost USD | hooks total/served/fallback | shell | MCP | tgrep |
|---|---|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|
| C1 / Prisma / wire-name-validation / urdira-typescript | gpt-5.6-luna | 3 | true | 2/2 | 0/0/0 | 16430 | 206157 | 717705 | 655360 | 7340 | 2703 | 727748 | 1.515754 | 23/8/15 | 3 | 0 | 0 |

The supplemental row observed 23 Urdira hook invocations (8 served, 15
fallback), 3 shell calls, MCP 0, and tgrep 0. Its retained output metrics and
provenance are in the addendum
`/Users/Cristian/BenchmarkResults/urdira-v8-derived-luna-campaigns-1-3-v1/summary/benchmark-campaigns-1-3-v5-supplemental-prisma-urdira.md`
(SHA-256 `92c754b7597b5847b19438302caeafb87400747622c1fa61f9bd77fb38931022`),
with JSON SHA-256
`01fbe484d537e1e933b3f414a00a78348b1a3c13f19b9e2ffa28ce3e73d7a4e4`. The
original strict Urdira cost summary remains unchanged at n=8, sum `$15.258346`,
mean `$1.907293`, median `$1.648912`, range `$1.393008-$3.348610`; its strict-
qualified subset is n=7, sum `$11.909736`, mean `$1.701391`, median `$1.638196`,
range `$1.393008-$2.276602`. The supplemental-filled descriptive Urdira
matrix is n=9, sum `$16.774100`, mean `$1.863789`, median `$1.638196`, range
`$1.393008-$3.348610`. Strict-qualified substitution is n=8, sum `$13.425490`,
mean `$1.678186`, median `$1.576975`, excluding the C3 VS Code/Urdira
tool-validation incident. The C1 Prisma pair is Urdira `$1.515754` versus baseline `$2.946698`
(-48.560932%), tgrep `$4.415286` (-65.670310%), codegraph `$3.344146`
(-54.674407%), and codebase-memory `$2.506416` (-39.525043%).

The v7 and v6 reports below remain historical and are not mixed into these 45
rows. The dated v8 evidence note is
[`2026-09-15-definitive-agent-benchmark-v8.md`](../evidence/2026-09-15-definitive-agent-benchmark-v8.md).

### Complete 45-cell measured table

The following table is embedded for review. The canonical cell index is the
frozen repository/arm identity (0-14); execution order was not measured and
is null. Cleanup raw and effective statuses are separate, and repair
references identify the retained external repair evidence.

|campaign|canonical cell|repository|task|arm|model invoked|turns|setup ms|elapsed ms|execution ordinal|input|cached input|output|reasoning|cost USD|hooks total/served/fallback|shell|MCP|agent exit|runner exit|grader exit|target coverage|task solved|grader pass|tool validation incident|cleanup raw|cleanup effective|repair reference|P95 ms|
|---:|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---|---|---|---|---|---:|
|1|0|playwright|affected-tests-deterministic|baseline|true|3|1270|209857|null|899391|838400|9020|3357|1.897798|0/0/null|21|0|0|0|0|2/2|true|true|false|passed|passed|null|null|
|1|1|playwright|affected-tests-deterministic|urdira-typescript|true|3|7033|179244|null|658500|614656|6832|2669|1.393008|22/14/8|6|0|0|0|0|2/2|true|true|false|passed|passed|null|null|
|1|2|playwright|affected-tests-deterministic|tgrep|true|3|1607|237641|null|1259710|1141760|9448|3119|2.619956|0/0/null|22|0|0|0|0|2/2|true|true|false|passed|passed|null|null|
|1|3|playwright|affected-tests-deterministic|codegraph|true|3|11652|229631|null|1129906|1021696|8993|2931|2.355204|0/0/null|24|0|0|0|0|2/2|true|true|false|blocked|passed_after_separate_repair|/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/campaign-1-codegraph-orphan-cleanup-v1.json (0d81e04761b19c805713b50f512e01311f9a85ddebe4f317b3e1f828790f82bf)|null|
|1|4|playwright|affected-tests-deterministic|codebase-memory|true|3|68347|211819|null|938147|851456|8067|2922|1.964206|0/0/null|15|0|0|0|0|2/2|true|true|false|passed|passed|null|null|
|1|5|prisma|wire-name-validation|baseline|true|3|4756|261287|null|1416425|1329408|10114|4117|2.946698|0/0/null|8|0|0|0|0|2/2|true|true|false|passed|passed|null|null|
|1|6|prisma|wire-name-validation|urdira-typescript|null|null|null|null|null|null|null|null|null|null|null/null/null|null|null|null|1|null|null/null|null|null|null|passed|passed|null|null|
|1|7|prisma|wire-name-validation|tgrep|true|3|5601|315205|null|2148247|2025472|10564|4285|4.415286|0/0/null|14|0|0|0|0|2/2|true|true|false|passed|passed|null|null|
|1|8|prisma|wire-name-validation|codegraph|true|3|15802|262732|null|1612897|1520640|10799|3995|3.344146|0/0/null|16|0|0|0|0|2/2|true|true|false|blocked|passed_after_separate_repair|/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/resume-coordinator/campaign-1-codegraph-orphan-cleanup-v2.json (312bb5eb69d29422a3b2c50ebc6b3c9dbee90e3de050c37d377e569757efb47c)|null|
|1|9|prisma|wire-name-validation|codebase-memory|true|3|267757|239536|null|1191420|1119488|10805|4642|2.506416|0/0/null|10|0|0|0|0|2/2|true|true|false|passed|passed|null|null|
|1|10|vscode|language-provider-registration-idempotence|baseline|true|3|1623|256349|null|1468110|1389312|10283|4480|3.054324|0/0/null|17|0|0|0|0|2/2|true|true|false|passed|passed|null|null|
|1|11|vscode|language-provider-registration-idempotence|urdira-typescript|true|3|41035|240098|null|670920|585728|7631|3290|1.429208|17/3/14|12|0|0|0|0|2/2|true|true|false|passed|passed|null|null|
|1|12|vscode|language-provider-registration-idempotence|tgrep|true|3|4384|282006|null|1443328|1367552|10665|4771|3.010144|0/0/null|17|0|0|0|0|2/2|true|true|false|passed|passed|null|null|
|1|13|vscode|language-provider-registration-idempotence|codegraph|true|3|79050|265936|null|1089584|1024768|11705|6031|2.321056|0/0/null|13|0|0|0|0|2/2|true|true|false|blocked|passed_after_separate_repair|/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/resume-coordinator/vscode-c1-14-codegraph-orphan-cleanup-v2.json (c4bbbb7bedbae24d59a298571536ea00a3f146099ff6e431b67df208ccb8f32e)|null|
|1|14|vscode|language-provider-registration-idempotence|codebase-memory|true|0|214728|25559|null|null|null|null|null|null|0/0/null|1|0|1|1|1|0/2|false|false|false|passed|passed|null|null|
|2|0|playwright|affected-tests-deterministic|baseline|true|3|901|257581|null|660613|610048|7227|2384|1.398114|0/0/null|16|0|0|0|0|2/2|true|true|false|passed|passed|null|null|
|2|1|playwright|affected-tests-deterministic|urdira-typescript|true|3|7185|271655|null|778170|717568|7342|2890|1.638196|17/11/6|5|0|0|0|0|2/2|true|true|false|passed|passed|null|null|
|2|2|playwright|affected-tests-deterministic|tgrep|true|3|1543|398978|null|660120|613888|8136|2604|1.40616|0/0/null|23|0|0|0|0|2/2|true|true|false|passed|passed|null|null|
|2|3|playwright|affected-tests-deterministic|codegraph|true|3|10555|318113|null|993531|893952|10682|3599|2.10131|0/0/null|25|0|0|0|0|2/2|true|true|false|blocked|passed_after_separate_repair|/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/campaign-2-codegraph-orphan-cleanup-v2.json (7dfb642d7d00d7e6a6de53637be45049163abf10b1d51684726280d7e46ac279)|null|
|2|4|playwright|affected-tests-deterministic|codebase-memory|true|3|6119|447866|null|1305561|1236992|10854|3584|2.726626|0/0/null|27|0|0|0|0|2/2|true|true|false|passed|passed|null|null|
|2|5|prisma|wire-name-validation|baseline|true|3|4600|228446|null|1551382|1473792|10070|3569|3.211876|0/0/null|13|0|0|0|0|2/2|true|true|false|passed|passed|null|null|
|2|6|prisma|wire-name-validation|urdira-typescript|true|3|13643|279289|null|983483|884992|8294|3280|2.059558|17/9/8|7|0|0|0|0|2/2|true|true|false|passed|passed|null|null|
|2|7|prisma|wire-name-validation|tgrep|true|3|5416|323169|null|1620615|1539840|10047|4284|3.355878|0/0/null|11|0|0|0|0|2/2|true|true|false|passed|passed|null|null|
|2|8|prisma|wire-name-validation|codegraph|true|3|16340|230493|null|945018|870144|8999|3704|1.99166|0/0/null|8|0|0|0|0|2/2|true|true|false|blocked|passed_after_separate_repair|/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/campaign-2-codegraph-orphan-cleanup-v3.json (441cc6378ee497788b45ff3108f4c7905d7743341dfc7ba4ea089744484873fb)|null|
|2|9|prisma|wire-name-validation|codebase-memory|true|3|13083|242944|null|1348890|1263104|10068|4249|2.812316|0/0/null|12|0|0|0|0|2/2|true|true|false|passed|passed|null|null|
|2|10|vscode|language-provider-registration-idempotence|baseline|true|3|2409|280427|null|962498|898816|8627|3687|2.023508|0/0/null|13|0|0|0|0|2/2|true|true|false|passed|passed|null|null|
|2|11|vscode|language-provider-registration-idempotence|urdira-typescript|true|3|41202|320106|null|1084393|968192|9519|3958|2.276602|20/3/17|14|0|0|0|0|2/2|true|true|false|passed|passed|null|null|
|2|12|vscode|language-provider-registration-idempotence|tgrep|true|3|4114|223492|null|1274124|1201408|9397|3791|2.653752|0/0/null|15|0|0|0|0|2/2|true|true|false|passed|passed|null|null|
|2|13|vscode|language-provider-registration-idempotence|codegraph|true|3|79603|286550|null|1667235|1579264|12287|5112|3.473662|0/0/null|16|0|0|0|0|2/2|true|true|false|blocked|passed_after_separate_repair|/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/campaign-2-codegraph-orphan-cleanup-c2-13-v1.json (e914ee80acf665fa1e8142e6190f351ce7d78f558b5bf5954ebb37008a2d1052)|null|
|2|14|vscode|language-provider-registration-idempotence|codebase-memory|true|3|75729|223812|null|1063379|976896|9241|4255|2.234726|0/0/null|14|0|0|0|0|2/2|true|true|false|passed|passed|null|null|
|3|0|playwright|affected-tests-deterministic|baseline|true|3|1331|235103|null|876178|806144|10833|4990|1.87894|0/0/null|18|0|0|0|0|2/2|true|true|false|passed|passed|null|null|
|3|1|playwright|affected-tests-deterministic|urdira-typescript|true|3|7766|244131|null|780770|707328|9048|3213|1.659628|25/12/13|10|0|0|0|0|2/2|true|true|false|passed|passed|null|null|
|3|2|playwright|affected-tests-deterministic|tgrep|true|3|1546|230859|null|876664|811776|9978|3362|1.860048|0/0/null|25|0|0|0|0|2/2|true|true|false|passed|passed|null|null|
|3|3|playwright|affected-tests-deterministic|codegraph|true|3|11304|194388|null|588513|537344|8893|3533|1.276434|0/0/null|16|0|0|0|0|2/2|true|true|false|blocked|passed_after_separate_repair|/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/campaign-3-codegraph-orphan-cleanup-c3-02-v1.json (874646adb71b49005b722ae62049a039753184bd3fc90fec49bda881372c0da4)|null|
|3|4|playwright|affected-tests-deterministic|codebase-memory|true|3|6218|204452|null|704845|628224|7791|2428|1.491442|0/0/null|17|0|0|0|0|2/2|true|true|false|passed|passed|null|null|
|3|5|prisma|wire-name-validation|baseline|true|3|4434|247725|null|1495494|1403648|10534|3651|3.104468|0/0/null|13|0|0|0|0|2/2|true|true|false|passed|passed|null|null|
|3|6|prisma|wire-name-validation|urdira-typescript|true|3|13579|197334|null|678648|614400|8126|3904|1.453536|14/6/8|7|0|0|0|0|2/2|true|true|false|passed|passed|null|null|
|3|7|prisma|wire-name-validation|tgrep|true|3|5925|301022|null|3146462|3028992|12105|4672|6.42714|0/0/null|13|0|0|0|0|2/2|true|true|false|passed|passed|null|null|
|3|8|prisma|wire-name-validation|codegraph|true|3|18437|252541|null|1229793|1157120|9485|3977|2.567282|0/0/null|9|0|0|0|0|2/2|true|true|false|blocked|passed_after_separate_repair|/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/campaign-3-codegraph-orphan-cleanup-c3-07-v1.json (d8bb453982b06750c4bef878fa6f12e1e123e24cbb436a28a4e37224ffe380fa)|null|
|3|9|prisma|wire-name-validation|codebase-memory|true|3|13210|292775|null|2173238|2016768|12014|3935|4.474068|0/0/null|22|0|0|0|0|2/2|true|true|false|passed|passed|null|null|
|3|10|vscode|language-provider-registration-idempotence|baseline|true|3|1253|291782|null|1742177|1642240|11781|4571|3.61517|0/0/null|18|0|0|0|0|2/2|true|true|false|passed|passed|null|null|
|3|11|vscode|language-provider-registration-idempotence|urdira-typescript|true|3|41284|386208|null|1602345|1471488|13334|4656|3.34861|27/11/16|15|0|0|1|1|2/2|true|false|true|passed|passed|null|null|
|3|12|vscode|language-provider-registration-idempotence|tgrep|true|3|4770|371465|null|1586864|1501952|12894|5731|3.322728|0/0/null|16|0|0|0|0|2/2|true|true|false|passed|passed|null|null|
|3|13|vscode|language-provider-registration-idempotence|codegraph|true|3|78699|252472|null|1266196|1196288|11642|5737|2.671424|0/0/null|13|0|0|0|0|2/2|true|true|false|blocked|passed_after_separate_repair|/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/campaign-3-codegraph-orphan-cleanup-c3-12-v1.json (SHA-256 8dd5a14120c1e694187c53d8f3e870b519ad41629dc2009d58be82102ba2fb2b)|null|
|3|14|vscode|language-provider-registration-idempotence|codebase-memory|true|3|79348|302910|null|1257967|1149440|10765|4487|2.63795|0/0/null|11|0|0|0|0|2/2|true|true|false|passed|passed|null|null|

### Additional per-cell measured context and accounting panel

This 45-row panel exposes measured fields that are not part of the compact
27-column result table. Values are copied from the retained v8 consolidation
JSON; absent source fields are `null`. “Completed output” is the complete
character count when available, while “known output” is the retained lower
bound. Component character counts are classifications and are not additive.
The source has no numeric test-coverage or full-model-context field, so those
columns are explicitly `null`; test execution counts remain reported. The
append-only axis correction that maps each row to `task_solved`, `grader_pass`,
and `tool_validation_incident` is retained in the v4 sidecar cited above. The
configured arm remains separate from observed tool use, and P95 remains
`null` under the three-sample rule.

|campaign|cell|repository|task|arm|outer turns observed/requested|command actions|repository read calls|observed shell/MCP/tgrep|hook total/served/fallback|completed output chars total|completed output chars shell|completed output chars hook|completed output chars MCP|completed output chars tgrep|known output chars total|known output chars shell|known output chars hook|known output chars MCP|known output chars tgrep|exact repeated output chars|exact shell repeated after MCP chars|source reads total/before/after|source overlap/nonoverlap/unclassified|test attempts/passes/failures/unknown|numeric coverage|full model context chars|timed out|retry count|token evidence status|counter mode|host/transcript turns|turn completion observed|source correctness category|failure kind|failure reason|grader status|
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
|1|0|playwright|affected-tests-deterministic|baseline|3/3|30|21|21/0/0|0/0/null|129392|129392|null|null|null|null|129392|0|0|0|0|0|21/21/0|null/null/21|0/0/0/0|null|null|false|0|matched|cumulative|3/3|null|correctness_pass|null|null|null|
|1|1|playwright|affected-tests-deterministic|urdira-typescript|3/3|19|20|6/0/0|22/14/8|null|null|null|null|null|null|19770|32864|0|0|21|0|12/12/0|null/null/12|1/0/1/0|null|null|false|0|matched|cumulative|3/3|null|correctness_pass|null|null|null|
|1|2|playwright|affected-tests-deterministic|tgrep|3/3|31|22|22/0/0|0/0/null|1159658|1159658|null|null|null|null|1159658|0|0|0|0|0|22/22/0|null/null/22|0/0/0/0|null|null|false|0|matched|cumulative|3/3|null|correctness_pass|null|null|null|
|1|3|playwright|affected-tests-deterministic|codegraph|3/3|36|24|24/0/0|0/0/null|117774|117774|null|null|null|null|117774|0|0|0|899|0|24/24/0|null/null/24|0/0/0/0|null|null|false|0|matched|cumulative|3/3|null|correctness_pass|null|null|null|
|1|4|playwright|affected-tests-deterministic|codebase-memory|3/3|20|15|15/0/0|0/0/null|81338|81338|null|null|null|null|81338|0|0|0|1155|0|15/15/0|null/null/15|0/0/0/0|null|null|false|0|matched|cumulative|3/3|null|correctness_pass|null|null|null|
|1|5|prisma|wire-name-validation|baseline|3/3|17|8|8/0/0|0/0/null|182799|182799|null|null|null|null|182799|0|0|0|0|0|8/8/0|null/null/8|2/0/2/0|null|null|false|0|matched|cumulative|3/3|null|correctness_pass|null|null|null|
|1|6|prisma|wire-name-validation|urdira-typescript|null/null|null|null|null/null/null|null/null/null|null|null|null|null|null|null|null|null|null|null|null|null|null/null/null|null/null/null|null/null/null/null|null|null|false|0|null|null|null/null|null|infrastructure_failure|null|no transcript/manifest; runner exited 1 before model|null|
|1|7|prisma|wire-name-validation|tgrep|3/3|24|14|14/0/0|0/0/null|260607|260607|null|null|null|null|260607|0|0|0|0|0|14/14/0|null/null/14|2/0/1/1|null|null|false|0|matched|cumulative|3/3|null|correctness_pass|null|null|null|
|1|8|prisma|wire-name-validation|codegraph|3/3|30|16|16/0/0|0/0/null|205433|205433|null|null|null|null|205433|0|0|0|0|0|16/16/0|null/null/16|2/0/2/0|null|null|false|0|matched|cumulative|3/3|null|correctness_pass|null|null|null|
|1|9|prisma|wire-name-validation|codebase-memory|3/3|21|10|10/0/0|0/0/null|128404|128404|null|null|null|null|128404|0|0|0|0|0|10/10/0|null/null/10|2/0/1/1|null|null|false|0|matched|cumulative|3/3|null|correctness_pass|null|null|null|
|1|10|vscode|language-provider-registration-idempotence|baseline|3/3|22|17|17/0/0|0/0/null|182888|182888|null|null|null|null|182888|0|0|0|0|0|17/17/0|null/null/17|0/0/0/0|null|null|false|0|matched|cumulative|3/3|null|correctness_pass|null|null|null|
|1|11|vscode|language-provider-registration-idempotence|urdira-typescript|3/3|13|15|12/0/0|17/3/14|49207|49207|null|null|null|null|49207|0|0|0|149|0|12/12/0|null/null/12|0/0/0/0|null|null|false|0|matched|cumulative|3/3|null|correctness_pass|null|null|null|
|1|12|vscode|language-provider-registration-idempotence|tgrep|3/3|22|17|17/0/0|0/0/null|1125366|1125366|null|null|null|null|1125366|0|0|0|0|0|17/17/0|null/null/17|0/0/0/0|null|null|false|0|matched|cumulative|3/3|null|correctness_pass|null|null|null|
|1|13|vscode|language-provider-registration-idempotence|codegraph|3/3|18|13|13/0/0|0/0/null|237160|237160|null|null|null|null|237160|0|0|0|0|0|13/13/0|null/null/13|0/0/0/0|null|null|false|0|matched|cumulative|3/3|null|correctness_pass|null|null|null|
|1|14|vscode|language-provider-registration-idempotence|codebase-memory|0/3|1|1|1/0/0|0/0/null|42149|42149|null|null|null|null|42149|0|0|0|0|0|1/1/0|null/null/1|0/0/0/0|null|null|false|0|mismatch|cumulative|1/0|false|execution_failure|execution_failure|Codex request reached host/model path but selected model was at capacity; turn failed before turn.completed; no grader completion artifact.|not_evaluated_or_missing_completion_evidence|
|2|0|playwright|affected-tests-deterministic|baseline|3/3|21|16|16/0/0|0/0/null|91158|91158|null|null|null|null|91158|0|0|0|0|0|16/16/0|null/null/16|0/0/0/0|null|null|false|0|null|cumulative|null/null|null|correctness_pass|null|null|null|
|2|1|playwright|affected-tests-deterministic|urdira-typescript|3/3|14|16|5/0/0|17/11/6|null|null|null|null|null|null|55023|21125|0|0|0|0|9/9/0|null/null/9|1/0/1/0|null|null|false|0|null|cumulative|null/null|null|correctness_pass|null|null|null|
|2|2|playwright|affected-tests-deterministic|tgrep|3/3|33|23|23/0/0|0/0/null|85343|85343|null|null|null|null|85343|0|0|0|1121|0|23/23/0|null/null/23|2/0/2/0|null|null|false|0|null|cumulative|null/null|null|correctness_pass|null|null|null|
|2|3|playwright|affected-tests-deterministic|codegraph|3/3|37|25|25/0/0|0/0/null|122064|122064|null|null|null|null|122064|0|0|0|0|0|25/25/0|null/null/25|1/0/1/0|null|null|false|0|null|cumulative|null/null|null|correctness_pass|null|null|null|
|2|4|playwright|affected-tests-deterministic|codebase-memory|3/3|39|27|27/0/0|0/0/null|141008|141008|null|null|null|null|141008|0|0|0|0|0|27/27/0|null/null/27|2/0/2/0|null|null|false|0|null|cumulative|null/null|null|correctness_pass|null|null|null|
|2|5|prisma|wire-name-validation|baseline|3/3|25|13|13/0/0|0/0/null|162521|162521|null|null|null|null|162521|0|0|0|0|0|13/13/0|null/null/13|1/0/1/0|null|null|false|0|null|cumulative|null/null|null|correctness_pass|null|null|null|
|2|6|prisma|wire-name-validation|urdira-typescript|3/3|14|16|7/0/0|17/9/8|null|null|null|null|null|null|46818|14521|0|0|0|0|7/7/0|null/null/7|2/0/2/0|null|null|false|0|null|cumulative|null/null|null|correctness_pass|null|null|null|
|2|7|prisma|wire-name-validation|tgrep|3/3|17|11|11/0/0|0/0/null|1209343|1209343|null|null|null|null|1209343|0|0|0|0|0|11/11/0|null/null/11|1/0/0/1|null|null|false|0|null|cumulative|null/null|null|correctness_pass|null|null|null|
|2|8|prisma|wire-name-validation|codegraph|3/3|15|8|8/0/0|0/0/null|131340|131340|null|null|null|null|131340|0|0|0|0|0|8/8/0|null/null/8|2/0/1/1|null|null|false|0|null|cumulative|null/null|null|correctness_pass|null|null|null|
|2|9|prisma|wire-name-validation|codebase-memory|3/3|25|12|12/0/0|0/0/null|134917|134917|null|null|null|null|134917|0|0|0|0|0|12/12/0|null/null/12|3/0/1/2|null|null|false|0|null|cumulative|null/null|null|correctness_pass|null|null|null|
|2|10|vscode|language-provider-registration-idempotence|baseline|3/3|16|13|13/0/0|0/0/null|152386|152386|null|null|null|null|152386|0|0|0|0|0|13/13/0|null/null/13|0/0/0/0|null|null|false|0|null|cumulative|null/null|null|correctness_pass|null|null|null|
|2|11|vscode|language-provider-registration-idempotence|urdira-typescript|3/3|16|17|14/0/0|20/3/17|501636|501636|null|null|null|null|501636|0|0|0|46|0|14/14/0|null/null/14|0/0/0/0|null|null|false|0|null|cumulative|null/null|null|correctness_pass|null|null|null|
|2|12|vscode|language-provider-registration-idempotence|tgrep|3/3|18|15|15/0/0|0/0/null|155423|155423|null|null|null|null|155423|0|0|0|160|0|15/15/0|null/null/15|0/0/0/0|null|null|false|0|null|cumulative|null/null|null|correctness_pass|null|null|null|
|2|13|vscode|language-provider-registration-idempotence|codegraph|3/3|22|16|16/0/0|0/0/null|304235|304235|null|null|null|null|304235|0|0|0|0|0|16/16/0|null/null/16|0/0/0/0|null|null|false|0|null|cumulative|null/null|null|correctness_pass|null|null|null|
|2|14|vscode|language-provider-registration-idempotence|codebase-memory|3/3|18|14|14/0/0|0/0/null|123236|123236|null|null|null|null|123236|0|0|0|0|0|14/14/0|null/null/14|0/0/0/0|null|null|false|0|null|cumulative|null/null|null|correctness_pass|null|null|null|
|3|0|playwright|affected-tests-deterministic|baseline|3/3|25|18|18/0/0|0/0/null|137375|137375|null|null|null|null|137375|0|0|0|1165|0|18/18/0|null/null/18|0/0/0/0|null|null|false|0|null|cumulative|null/null|null|correctness_pass|null|null|null|
|3|1|playwright|affected-tests-deterministic|urdira-typescript|3/3|21|22|10/0/0|25/12/13|null|null|null|null|null|null|48221|17574|0|0|21|0|15/15/0|null/null/15|1/0/0/1|null|null|false|0|null|cumulative|null/null|null|correctness_pass|null|null|null|
|3|2|playwright|affected-tests-deterministic|tgrep|3/3|37|25|25/0/0|0/0/null|138521|138521|null|null|null|null|138521|0|0|0|0|0|25/25/0|null/null/25|0/0/0/0|null|null|false|0|null|cumulative|null/null|null|correctness_pass|null|null|null|
|3|3|playwright|affected-tests-deterministic|codegraph|3/3|24|16|16/0/0|0/0/null|104988|104988|null|null|null|null|104988|0|0|0|0|0|16/16/0|null/null/16|0/0/0/0|null|null|false|0|null|cumulative|null/null|null|correctness_pass|null|null|null|
|3|4|playwright|affected-tests-deterministic|codebase-memory|3/3|26|17|17/0/0|0/0/null|92612|92612|null|null|null|null|92612|0|0|0|0|0|17/17/0|null/null/17|0/0/0/0|null|null|false|0|null|cumulative|null/null|null|correctness_pass|null|null|null|
|3|5|prisma|wire-name-validation|baseline|3/3|28|13|13/0/0|0/0/null|203314|203314|null|null|null|null|203314|0|0|0|0|0|13/13/0|null/null/13|5/0/4/1|null|null|false|0|null|cumulative|null/null|null|null|null|null|null|
|3|6|prisma|wire-name-validation|urdira-typescript|3/3|11|13|7/0/0|14/6/8|46780|43115|3665|null|null|null|43115|3665|0|0|0|0|8/8/0|null/null/8|1/0/1/0|null|null|false|0|null|cumulative|null/null|null|null|null|null|null|
|3|7|prisma|wire-name-validation|tgrep|3/3|29|13|13/0/0|0/0/null|1219718|1219718|null|null|null|null|1219718|0|0|0|0|0|13/13/0|null/null/13|3/2/0/1|null|null|false|0|null|cumulative|null/null|null|correctness_pass|null|null|null|
|3|8|prisma|wire-name-validation|codegraph|3/3|14|9|9/0/0|0/0/null|113541|113541|null|null|null|null|113541|0|0|0|0|0|9/9/0|null/null/9|2/0/1/1|null|null|false|0|null|cumulative|null/null|null|correctness_pass|null|null|null|
|3|9|prisma|wire-name-validation|codebase-memory|3/3|34|22|22/0/0|0/0/null|316661|316661|null|null|null|null|316661|0|0|0|0|0|22/22/0|null/null/22|2/0/2/0|null|null|false|0|null|cumulative|null/null|null|null|null|null|null|
|3|10|vscode|language-provider-registration-idempotence|baseline|3/3|22|18|18/0/0|0/0/null|323985|323985|null|null|null|null|323985|0|0|0|0|0|18/18/0|null/null/18|0/0/0/0|null|null|false|0|null|cumulative|null/null|null|null|null|null|null|
|3|11|vscode|language-provider-registration-idempotence|urdira-typescript|3/3|23|26|15/0/0|27/11/16|null|null|null|null|null|null|89219|4075|0|0|447|0|15/15/0|null/null/15|0/0/0/0|null|null|false|0|null|cumulative|null/null|null|null|null|null|null|
|3|12|vscode|language-provider-registration-idempotence|tgrep|3/3|21|16|16/0/0|0/0/null|178475|178475|null|null|null|null|178475|0|0|0|0|0|16/16/0|null/null/16|0/0/0/0|null|null|false|0|null|cumulative|null/null|null|null|null|null|null|
|3|13|vscode|language-provider-registration-idempotence|codegraph|3/3|20|13|13/0/0|0/0/null|133007|133007|null|null|null|null|133007|0|0|0|0|0|13/13/0|null/null/13|0/0/0/0|null|null|false|0|null|cumulative|null/null|null|null|null|null|null|
|3|14|vscode|language-provider-registration-idempotence|codebase-memory|3/3|18|11|11/0/0|0/0/null|1193943|1193943|null|null|null|null|1193943|0|0|0|0|0|11/11/0|null/null/11|0/0/0/0|null|null|false|0|null|cumulative|null/null|null|null|null|null|null|

### Measurement panels

**Task outcome, grader, and coverage.** There are 43 `task_solved=true` rows
(target coverage 2/2 with final changes present), 42 `grader_pass=true` rows,
two `grader_pass=false` rows, and one `grader_pass=null` infrastructure row.
The C3 VS Code/Urdira row is task-solved and covered 2/2, but has
`grader_pass=false` and `tool_validation_incident=true` for
`core:unknown_field` at `/request/query`. The C1 VS Code/codebase-memory row is
`task_solved=false` at 0/2 after execution-capacity failure. The C1
Prisma/Urdira row is `task_solved=null` and `grader_pass=null`. These axes are
reported separately.

**Tokens, cost, and timing.** Matched host evidence provides token fields for
43 rows: input sum 53,231,751, cached input sum 49,232,384, output sum
424,939, reasoning sum 168,406, and additive total sum 53,425,096. The
corresponding frozen-card cost sum is $110.410262; this is a descriptive sum
across task-solved observed and other observed rows, not a ranking. The C3
VS Code/Urdira cost is included in observed descriptive aggregates despite its
strict grader nonpass; strict-grader-qualified comparisons exclude that row.
Setup and elapsed timing are available
for 44 rows, with setup sum 1,296,191 ms and elapsed sum 11,554,988 ms. Costs
use input/cached input $2/M and output/reasoning $8/M; provider totals remain
separate.

**Transport, context, and duplication.** Across rows with available evidence,
observed tool usage sums to shell 638, MCP 0, tgrep 0, and Urdira hook
invocations 159 (69 served and 90 fallback). Completed output evidence
contains 11,419,705 known characters across 39 rows: shell 11,416,040, hook
93,824, MCP 0, and tgrep 0 (component counts are reported separately and are
not additive across classifications). Exact repeated output totals 5,184
characters; exact shell output repeated after MCP is 0. Shell source-line
overlap is null for all rows because the required source payload was
unavailable; it is not interpreted as no overlap. Configured arm and observed
tool use remain separate.

**Failures and cleanup.** The C1 Prisma/Urdira row is an infrastructure
failure with task outcome and grader unavailable. The C1 VS Code/codebase-memory
row is an execution-capacity failure at 0/2. The C3 VS Code/Urdira row is
task-solved at 2/2, with agent exit 0 and a strict grader exit 1 caused by the
recorded tool-validation incident `core:unknown_field` at `/request/query`.
Nine raw cleanup records were blocked by owned processes; each has separate
retained repair evidence with effective pass status, while the other 36 raw
cleanup records passed. No cleanup record is collapsed into task outcome or
strict grader outcome.

**Descriptive distributions.** The table retains one observation per identity
per campaign. The following medians and min-max ranges are descriptive only;
no pooled arm ranking or inferential interval is claimed. P95 is null for
every identity because n=3 does not satisfy the frozen P95 eligibility rule.

| Repository/task/arm | elapsed n | elapsed median ms | elapsed range ms | total-token n | total-token median | total-token range |
|---|---:|---:|---|---:|---:|---|
| playwright / affected-tests-deterministic / baseline | 3 | 235103 | 209857-257581 | 3 | 892001 | 670224-911768 |
| playwright / affected-tests-deterministic / urdira-typescript | 3 | 244131 | 179244-271655 | 3 | 788402 | 668001-793031 |
| playwright / affected-tests-deterministic / tgrep | 3 | 237641 | 230859-398978 | 3 | 890004 | 670860-1272277 |
| playwright / affected-tests-deterministic / codegraph | 3 | 229631 | 194388-318113 | 3 | 1007812 | 600939-1141830 |
| playwright / affected-tests-deterministic / codebase-memory | 3 | 211819 | 204452-447866 | 3 | 949136 | 715064-1319999 |
| prisma / wire-name-validation / baseline | 3 | 247725 | 228446-261287 | 3 | 1509679 | 1430656-1565021 |
| prisma / wire-name-validation / urdira-typescript | 2 | 238311.5 | 197334-279289 | 2 | 842867.5 | 690678-995057 |
| prisma / wire-name-validation / tgrep | 3 | 315205 | 301022-323169 | 3 | 2163096 | 1634946-3163239 |
| prisma / wire-name-validation / codegraph | 3 | 252541 | 230493-262732 | 3 | 1243255 | 957721-1627691 |
| prisma / wire-name-validation / codebase-memory | 3 | 242944 | 239536-292775 | 3 | 1363207 | 1206867-2189187 |
| vscode / language-provider-registration-idempotence / baseline | 3 | 280427 | 256349-291782 | 3 | 1482873 | 974812-1758529 |
| vscode / language-provider-registration-idempotence / urdira-typescript | 3 | 320106 | 240098-386208 | 3 | 1097870 | 681841-1620335 |
| vscode / language-provider-registration-idempotence / tgrep | 3 | 282006 | 223492-371465 | 3 | 1458764 | 1287312-1605489 |
| vscode / language-provider-registration-idempotence / codegraph | 3 | 265936 | 252472-286550 | 3 | 1283575 | 1107320-1684634 |
| vscode / language-provider-registration-idempotence / codebase-memory | 3 | 223812 | 25559-302910 | 2 | 1175047 | 1076875-1273219 |

The source JSON preserves additional per-row failure-category, context,
transport, cleanup, provenance, and host-evidence fields. Historical v7/v6
rows remain separate.

The VS Code/codebase-memory elapsed distribution is a mixed-outcome
description: one of its three observations has zero turns and failure exits.
Its timing remains reported for completeness and is not a successful-efficiency
result. The Prisma/Urdira row has two finite elapsed and token observations;
its fractional medians are retained rather than silently rounded.


### Readiness final planned-row table

The readiness phase is represented by all 18 planned probe rows. No probe
achieved model invocation, and no retry was counted. The table preserves
failed, blocked, and interrupted states separately from agent correctness and
efficiency. Measurements absent from retained readiness evidence remain `null`.

Source composition: `/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/readiness-final-composition-v1.json` (SHA-256 `5a3be1432ac047084abdd24fbb4491c9219769c19683f4a51af06f5a616898a7`).

The append-only normalized status view is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/readiness-final-composition-v2.json`
(SHA-256 `2090d55be0745fe5f056b7058ecb1305ce22a7d34502595f087bf2bd0bb6328b`).
It preserves the v1 outcome counters and records the row-level reporting split
as 3 interrupted cold, 6 preflight failures, and 9 warm-blocked rows.

All 18 planned rows are persisted as failed, blocked, or interrupted readiness attempts. No row achieved model invocation; no retry was counted. Readiness measurements are `null` when no source evidence exists. Campaign is taken from the source row; for interrupted Playwright rows whose source omitted campaign, the probe identity suffix supplies the campaign label without inferring any measurement.

| campaign | probe | repository | task | phase | status | model invoked | setup ms | structural readiness ms | first query ms | storage bytes | process RSS bytes | freshness | publication | failure |
|---:|---|---|---|---|---|---|---:|---:|---:|---:|---:|---|---|---|
| 1 | playwright-cold-1 | playwright | null | cold | interrupted_cold | false | null | null | null | null | null | null | null | SIGTERM interrupted readiness execution before readiness manifest persisted |
| 1 | playwright-warm-1 | playwright | null | warm | warm_blocked | false | null | null | null | null | null | null | null | warm probe blocked by cold failure; no retry |
| 1 | prisma-cold-1 | prisma | wire-name-validation | cold | preflight_failed | false | null | null | null | 102401 | 2171535360 | null | null | listen EINVAL: invalid argument /Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/readiness-v8-resume-after-c1-playwright-v2/data/prisma-1/daemon.sock |
| 1 | prisma-warm-1 | prisma | wire-name-validation | warm | warm_blocked | false | null | null | null | null | null | null | null | warm probe blocked by cold failure: listen EINVAL: invalid argument /Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/readiness-v8-resume-after-c1-playwright-v2/data/prisma-1/daemon.sock |
| 1 | vscode-cold-1 | vscode | language-provider-registration-idempotence | cold | preflight_failed | false | null | null | null | 102401 | 815742976 | null | null | listen EINVAL: invalid argument /Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/readiness-v8-resume-after-c1-playwright-v2/data/vscode-1/daemon.sock |
| 1 | vscode-warm-1 | vscode | language-provider-registration-idempotence | warm | warm_blocked | false | null | null | null | null | null | null | null | warm probe blocked by cold failure: listen EINVAL: invalid argument /Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/readiness-v8-resume-after-c1-playwright-v2/data/vscode-1/daemon.sock |
| 2 | playwright-cold-2 | playwright | affected-tests-deterministic | cold | preflight_failed | false | null | null | null | 102401 | 812466176 | null | null | listen EINVAL: invalid argument /Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/readiness-v8-resume-after-c1-playwright-v2/data/playwright-2/daemon.sock |
| 2 | playwright-warm-2 | playwright | affected-tests-deterministic | warm | warm_blocked | false | null | null | null | null | null | null | null | warm probe blocked by cold failure: listen EINVAL: invalid argument /Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/readiness-v8-resume-after-c1-playwright-v2/data/playwright-2/daemon.sock |
| 2 | prisma-cold-2 | prisma | wire-name-validation | cold | preflight_failed | false | null | null | null | 102401 | 803553280 | null | null | listen EINVAL: invalid argument /Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/readiness-v8-resume-after-c1-playwright-v2/data/prisma-2/daemon.sock |
| 2 | prisma-warm-2 | prisma | wire-name-validation | warm | warm_blocked | false | null | null | null | null | null | null | null | warm probe blocked by cold failure: listen EINVAL: invalid argument /Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/readiness-v8-resume-after-c1-playwright-v2/data/prisma-2/daemon.sock |
| 2 | vscode-cold-2 | vscode | language-provider-registration-idempotence | cold | interrupted_cold | false | null | null | null | 102401 | 794935296 | null | null | readiness cold interrupted by SIGINT |
| 2 | vscode-warm-2 | vscode | language-provider-registration-idempotence | warm | warm_blocked | false | null | null | null | null | null | null | null | warm probe blocked by cold failure: readiness cold interrupted by SIGINT |
| 3 | playwright-cold-3 | playwright | null | cold | interrupted_cold | false | null | null | null | null | null | null | null | SIGTERM interrupted readiness execution before readiness manifest persisted |
| 3 | playwright-warm-3 | playwright | null | warm | warm_blocked | false | null | null | null | null | null | null | null | warm probe blocked by cold interruption; no retry |
| 3 | prisma-cold-3 | prisma | wire-name-validation | cold | preflight_failed | false | null | null | null | null | null | null | null | warm probe blocked by cold failure: Frozen dependency manager mismatch in /Users/Cristian/BenchmarkCells/v8/r5-o/prisma-3/checkout: expected pnpm 10.27.0, received /Users/Cristian/.nvm/versions/node/v24.18.1/lib/node_modules/corepack/dist/corepack.js:2 process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT??=' |
| 3 | prisma-warm-3 | prisma | wire-name-validation | warm | warm_blocked | false | null | null | null | null | null | null | null | warm probe blocked by cold failure: warm probe blocked by cold failure: Frozen dependency manager mismatch in /Users/Cristian/BenchmarkCells/v8/r5-o/prisma-3/checkout: expected pnpm 10.27.0, received /Users/Cristian/.nvm/versions/node/v24.18.1/lib/node_modules/corepack/dist/corepack.js:2 process.env |
| 3 | vscode-cold-3 | vscode | language-provider-registration-idempotence | cold | preflight_failed | false | null | null | null | null | null | null | null | warm probe blocked by cold failure: Frozen dependency manager mismatch in /Users/Cristian/BenchmarkCells/v8/r6-o/vscode-3/checkout: expected npm, received internal/modules/cjs/loader.js:589     throw err;     ^  Error: Cannot find module 'node:path'     at Function.Module._resolveFilename (internal/ |
| 3 | vscode-warm-3 | vscode | language-provider-registration-idempotence | warm | warm_blocked | false | null | null | null | null | null | null | null | warm probe blocked by cold failure: warm probe blocked by cold failure: Frozen dependency manager mismatch in /Users/Cristian/BenchmarkCells/v8/r6-o/vscode-3/checkout: expected npm, received internal/modules/cjs/loader.js:589     throw err;     ^  Error: Cannot find module 'node:path'     at Functio |

Summary: 18 planned, 18 observed/started as retained readiness attempts, 0 successful, 18 failed/blocked/interrupted, 0 pending. The table separates readiness execution status from agent correctness and efficiency; it contains no model-performance result.

**Readiness measurement panel.** The final composition reports
`model_invoked=false` for all 18 rows. Setup elapsed time, structural
readiness, time to first query, snapshot identity, page completeness, semantic
sidecar creation, freshness, and publication each have 0/18 measured values;
the five retained preflight rows that created storage/process evidence expose
storage and process fields in the source composition and table. No readiness
probe produced a query or a distribution sample, so readiness latency, cost,
token, correctness, coverage, efficiency, and P95 are all `null`.

### Final per-campaign renderer evidence (2026-09-16)

The frozen renderer was run separately for each campaign, consuming 15
original agent rows and six final readiness rows per campaign. The resulting
JSON/Markdown output pairs are retained outside the repository and summarized
in the [post-campaign rendering evidence](../evidence/2026-09-16-definitive-agent-benchmark-v8-postcampaign.md).

| Campaign | Agent rows | Readiness rows | Successful agent rows | Renderer JSON SHA-256 | Renderer Markdown SHA-256 | Readiness gate |
|---:|---:|---:|---:|---|---|---|
| 1 | 15 | 6 | 13 | `530317c4301796e01db13799f4f99e9d9c155b35dcd2ca33151a6341f2c5785e` | `a3affabc3f73f2029f3b58eacdab864de03da61bc620fd83254990d583b5ed6d` | false, 0/6 |
| 2 | 15 | 6 | 15 | `ac24dcb4ef1f942556756de2cf41e241b6613648a16f381d0fdae156192aabed` | `184594cc6af2f7b177b0c0de1451acf58c2106d3096775d0a83ba008951fa93e` | false, 0/6 |
| 3 | 15 | 6 | 14 | `708ecc119787a7fca6ce8e306ebbb8b7c882324f4fd69036925eee5ba6f973e2` | `e1a0f137908789c8a3f60b8245cd53e9d27f84bbe57fc4e89575b810ed58ab6f` | false, 0/6 |

An attempted aggregate render was rejected by the frozen selected-45
uniqueness guard because it omits campaign from the repository/task/arm key;
no guard bypass or aggregate frozen-renderer pass is claimed. Its external
attempt manifest SHA-256 is
`cb066e62d2d4ef68deec16f815056d9d2e06da226e29b035f27b941b8a00cf23` and its
failure log SHA-256 is
`23bc47e73a3e3ca221cdc71ca18f86d329c6ffa0e13df52a8865e0d9c3c86b15`.

## Historical v7 retained result

Status: **historical v7 blocked after two campaign-1 cell attempts** (2026-09-15). The retained v7 execution is a superseded measurement state: one completed baseline cell, one Urdira infrastructure failure before model invocation, 43 agent cells not started, and all 18 readiness probes not started. The user-authorized order is 45 agent cells followed by 18 readiness probes; the stop policy records no retry. This is a blocked partial result, not a completed 45-cell or 18-probe benchmark.

| Result set | Expected | Attempted / observed | Successful | Failed or blocked | Not started | Status |
|---|---:|---:|---:|---:|---:|---|
| Agent cells | 45 | 2 | 1 | 1 | 43 | blocked |
| Readiness probes | 18 | 0 | 0 | 0 | 18 | not started |

The retained raw campaign audit is `/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v7/execution-v7/campaign-1/campaign-audit.json` (SHA-256 `51f88c6e83cafd3016d897c0f959ba60a2db35afce8512359ba8899917140678`). The stop ledger is `.../series-v7/execution-v7/campaign-1/campaign-1-stop-ledger-v1.json` (SHA-256 `10cdabce6ab2aa0b4bec1f39cc525ee83ee91da80ba49f6d0b8dcf6ef9d2997d`) and the stop checkpoint is `.../campaign-1-stop-checkpoint-v1.json` (SHA-256 `9506ad6782b40cfb1b5fe8fca98cab67e0921f6f88e0402c5eb6456a2daa713a`). The three v7 cell manifest SHAs are `1500da83f9785090191cf1239fe5dfcc59e8b6ce0be6742d5ea644adc4e83d5d`, `376f0b6197de6335bcd0f6d6302d5ec8f37e6adca7ca7981ff869a1f9d9b2f0f`, and `7124780e7a9389e3cddffe550bee7b5781db983a006793e19d15dd6f46f84481`; the readiness manifest SHAs are `e007df8f43219a2965f27043763b39129c22b5e687268f4d218adc6cada685fd`, `172679656bbec427624c1de26a1936dc33d7b3a97e135f8d817d80ce10142e1d`, and `ea8a19187d95d3a82679290819e99647596a13a32eadca36d7e8c014c7aa7cf2`.

The baseline has retained evidence of a real model interaction: `model_invoked=true`, three successful Codex invocations, three matched host root turns, three `turn.completed` records, and matched cumulative host token evidence. Its measured values are input `816,937`, cached input `753,920`, output `8,575`, reasoning `3,000`, normative additive total `828,512`, provider-reported total `825,512` retained separately, and estimated cost `$1.726474` under the frozen rate card (input/cached $2/M, output/reasoning $8/M). The baseline completed in `239,518 ms` after the first instruction, with `501 ms` setup, exit `0`, grader exit `0`, and P95 `null`. Context measurements include 3 outer turns, 24 shell command calls, 19 source-read shell calls, 0 MCP/hook/tgrep calls, 107,043 repository-context characters, 70,765 target-attributed characters, and 36,278 unattributed characters; shell overlap is `null` with 19 unclassified source reads because no MCP source was present. Correctness evidence matched 2/2 target paths and had no unsafe omissions; numeric test coverage was unavailable (`null`).

The Urdira cell exited `1` during host readiness before model invocation; its retained error is `Urdira host exited before readiness (7/none)`, with `model_invoked=false` in the retained manifest. It is an infrastructure/coverage failure, not a model result. Its cleanup passed. Missing fields remain `null`; no zero is inferred. P95 is `null` because the definitive campaign has only one observed cell per identity and is incomplete.

The offline analyzer, replay, and renderer used retained v7 raw paths only and wrote to the new external directory `/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v7-derived-20260915-v1`. The partial audit SHA is `338740ef3d71ba0bff539f220019e0d0636e44ccbcff7c99ffb80b637567e453`; analyzer SHA `a9bfb18e7782e361a0d103b610b78417ede4cc3978aac77583a669a015e20def`; replay SHA `383b1395b08b900b7305875c20f1dc88a280fd43bef2d158bae185c0bbdea067`; rendered JSON SHA `2e7386c590337cee8528a55b7fb3825c8c522bf5a0f98533182a6898876a9de0`; rendered Markdown SHA `af776329beb5e6153d3d1519df7277c5b3e20b843337e8dfbf9cc1e27949ffe7`; artifact manifest SHA `0f067f161376ff657f96eb9a044c66e0c43fbc239c391f7868c3f1678c6316bf`. The full assembler was deliberately given only one campaign audit and one readiness manifest and rejected it with exit `1`, “exactly three campaign audits and three readiness manifests are required” (log SHA `c55f020b7877bf1fb8b453c309dcbb45faf0f8436cf9ea5f3f95a1dd916a52b1`). The partial renderer output is diagnostic and does not bypass the completeness gate.

The early baseline metric extraction is retained separately at `/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v7/early-metrics-baseline-v1/early-metrics-v1.json` (SHA-256 `7e4d5f7f368e59c42ec1fd78843d42a9bddc6773ac753f6e0e15ead956694e22`). v6 remains a historical blocked snapshot below and is not mixed with v7. Infrastructure-correction preparation for v8 is authorized, but it is preparation state rather than a new measurement or retry.


## Historical v6 result

The authoritative historical v6 series is frozen at Urdira commit
`5de04b14305bf1399b200b57db70efb888b99436`, Node `v24.18.1`, Luna, and
semantic indexing off. It stopped after two campaign-1 cells because the
Urdira cell failed preflight when the extracted CLI rejected `urdira --version`.
The baseline cell has a failed retained manifest; its `model_invoked=true`
field is not evidence of a real model request because its transcript is empty,
its timing sidecar has one zero-line turn, and host session evidence is absent.

The v6 matrix preserves all 45 expected cell identities: 2 attempted and 43
not started. All 18 readiness identities are present as not started because
readiness was scheduled after the 45 agent cells. The series is not complete,
and no retry or replacement run was added.

| Result set | Expected | Observed | Not started | Status |
|---|---:|---:|---:|---|
| Agent cells | 45 | 2 | 43 | blocked |
| Readiness probes | 18 | 0 | 18 | not started |

The v6 freeze, raw paths, cleanup evidence, hashes, analyzer output, replay,
and rendered partial matrix are recorded in
[`2026-09-15-definitive-agent-benchmark-v6.md`](../evidence/2026-09-15-definitive-agent-benchmark-v6.md).
The external derived output is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v6/derived-v6-blocked-20260915-v3`.
The v1 and v2 derived outputs remain preserved as superseded renderer results.
The v3 report corrects planned-row accounting and its stdout summary: 2
observed/attempted cells, 43 not started, 0 observed readiness probes, and 18
not started. Its JSON SHA is
`0820b6c6a75f9692d6947f3f8efec137662bbd32604ea242283b017e07bfe8e8` and its
Markdown SHA is
`10bfaec018ec878a299ee47f648a32044c6cdf6d94149356bf51779a1f8f2cdf`.
Unavailable metrics remain `null`; P95 is `null`; correctness, coverage,
efficiency, and distributions are not comparable for this incomplete series.

The remainder of this document preserves the earlier v5 blocked snapshot as
historical evidence. It is not merged into the v6 result.

This is the canonical versioned report location for the selected three
repository, five-arm, three-campaign measurement. The authorized v5 series is
blocked after two campaign-1 cells: the baseline cell has a failed retained
manifest, and the Urdira cell returned exit 1 without a retained manifest.
Forty-three cells were not attempted and no readiness probe executed. This
document therefore claims neither a completed 45-run campaign nor completed
18-probe readiness set. See the [self-contained handoff](definitive-agent-benchmark-handoff.md#final-reporting-and-publication).

## Current retained directed observations

These rows are existing observations retained from the cited evidence. They
are useful context for the pending campaign and are not a substitute for its
three independent campaigns. Missing values are `null`, never an inferred
zero.

| Repository / task | Arm | Sample | Runs / passes | Correctness / coverage | Comparable tokens | Readiness | Raw / evidence |
|---|---|---:|---:|---|---:|---:|---|
| Playwright / `affected-tests-deterministic` | Urdira | v72 | 1 / 1 | strict grader; focused validation 2/2 | 569,904 | 4.917 s | `docs/evidence/2026-09-14-agent-context-density.md` |
| Prisma / `wire-name-validation` | Urdira | v69 | 1 / 1 | strict grader; focused validation 260 tests + typecheck | 666,427 | 7.424 s | `docs/evidence/2026-09-13-current-urdira-context-density-benchmark.md` |
| VS Code / `language-provider-registration-idempotence` | Urdira | v86 | 1 / 1 | strict grader; independent validation | 970,632 | 29.536 s | `docs/evidence/2026-09-14-prompt-hook-context-reuse.md` |

The remaining definitive rows are `null` until the corresponding frozen
campaign artifacts exist. Competitor medians must be copied only from
task-matched reports with the same correctness and coverage; they are not
silently substituted from another repository or task.

## Required final table

The published final table has one row per repository, task, arm, and campaign,
with separate summary rows for medians, distributions, intervals, and failures.
It includes:

- runs, passes, grader/correctness, declared coverage and omissions;
- total, input, output, reasoning, and cached tokens; cost, rate card, and
  pricing policy;
- setup, agent, cold structural readiness, warm readiness, TTFQ, and E2E time;
- hook/MCP/shell/tgrep/tool-output/full-context characters and calls;
- continuations consumed/ignored, duplication/density, hydration, and typed
  fallback observations;
- repository/task/arm/sample, model, harness, source/release/worker/launcher
  commits and hashes, and raw artifact manifest paths.

Unavailable fields are `null`, never `0`. Raw transcripts remain outside the
repository; only sanitized derived reports and dated evidence are published.
Efficiency comparisons are emitted only for equal correction and coverage.

## Earlier preflight attempts (separate from authorized v5)

The immutable attempt ledger is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/preflight-attempt-ledger.json`
(`sha256=210a98e91cd89d0a57936cc6f11eb5302d2a9576668efc7085928ea7f7c6ae36`).
Both attempts used Node `v24.18.1`, reported `ready=false` with
`declared_dependencies_missing`, and listed 110 missing dependencies. Their
runner manifests record `model_invoked=false`; their timing sidecars have
empty `turns`, `mcp_calls`, and `command_calls`. The first attempt is retained
under `campaign-1-preflight-failure`; the second is under `campaign-1`.

The first audit has a provenance collision that also blocks acceptance: its
`cell_manifest` path points to the current second-attempt
`campaign-1/cell-manifest.json`, while its declared hash is
`d1d98ebb54361d95a876eefb55bc2f8f1650134c770951059f39807502870e13`, the
hash of the moved first manifest. The current path hashes to
`181ae2436700ea753588215d3be708c58ea903034d1c918c26f6810eeefa881c`.
The first and second campaign-audit hashes are respectively
`a53a6fd89314ceb3a05eb3e71e45e35392ae6858d8d6527648b25b490f01d91d` and
`46dcff6c2c874e0b1c2e16e0a53c1d8eb27ccd8e56017ce99f3a7a71459d38b2`.

### Dependency preparation evidence (separate from campaign attempts)

A retained v3 preparation attempt is a dependency-install failure, not a
runner or model attempt. Its record is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/dependency-worktree-validation-v3.json`
(`sha256=f134f45df6e912541535d869fa560bff946f8ac2eb23f625acc2edfc5ed5ceeb`).
It records `status=blocked`, `model_invoked=false`, and `runner_invoked=false`;
the offline store lacked `@biomejs/biome/-/biome-2.5.8.tgz` and pnpm returned
`ERR_PNPM_NO_OFFLINE_TARBALL`. This is retained as preparation diagnostics and
is not counted among the two campaign-1 preflight failures above.

The later per-worktree validation passed for the three selected repositories.
Its record is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/dependency-worktree-validation-v4.json`
(`sha256=7e1ec668265773ca0142fe0b9965326150e448148deb6fc7bcba5628e6882148`).
It records `status=passed`, `model_invoked=false`, `runner_invoked=false`, no
global cache use, all three worktrees ready with empty missing-dependency and
missing-runtime-artifact lists, and cleanup success with no worktree left
(`3/3`). Independent review found no blockers. This validates dependency
preparation only; it does not undo the immutable no-retry stop on the two
campaign attempts or authorize a new 45-cell/18-probe series.

### Proposed v5 freeze (prepared, not executed)

The current frozen proposal is retained at
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/proposed-series-v5/series-freeze-proposal.json`
(`sha256=9328d888cc30f11799faa305ed33db965e44d882780eb049626f6df9ba47a89e`).
Its reference-verification sidecar is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/proposed-series-v5/proposal-reference-verification.json`
(`sha256=30458467475c0ba85f4b9a75b307acb0ded0824fe366d4ccb204d8ff98b470bf`),
with 68 proposal hash references; the sidecar checks 71 references including
additional gate and retention references, plus six plan manifests. It declares
`proposal-not-executed`, `model_invoked=false`, 45 expected runs, 18 expected
readiness probes, model `gpt-5.6-luna`, Node `v24.18.1`, and
`minimum_free_bytes=53687091200`.

The six v5 manifest references are:

| Campaign | Cell manifest (SHA-256) | Readiness manifest (SHA-256) |
|---:|---|---|
| 1 | `campaign-1/cell-manifest.json` — `db8279aa8c190c617aaf1345ddbf9edc4c6912b914a2ba1ac328f50a06f73de9` | `campaign-1/readiness-manifest.json` — `9fa4155df5a992e30ac286462db780cdeea0a5fc0eb17f591e47a5a9e9458280` |
| 2 | `campaign-2/cell-manifest.json` — `ef00ee3dbfac49b2a80305005618c9bf74349bbe588303b845806e738c90e4cb` | `campaign-2/readiness-manifest.json` — `9c86e9649e5157a0093f36ae3200af02c31e1a91163609e3a192de5ad2390c40` |
| 3 | `campaign-3/cell-manifest.json` — `29aefe62fe7f3b1502fe6bd064b0de3f00bcd7aafe2272223235c9ad48000b71` | `campaign-3/readiness-manifest.json` — `e2cd3451285e22a4f3030ec7cfb1142962c258110c42285d1547a0938d9fd7ad` |

The proposal binds release binding v6
`/Users/Cristian/BenchmarkResults/urdira-final-release-binding-20260915-v6.json`
(`bytes=6042`, `sha256=352e9d7d49760178864ce64c015918e5d80861d167ab0c7b0e92bc30b691b6fc`)
and cleanup checkpoint v7
`/Users/Cristian/BenchmarkResults/urdira-phase0-cleanup-checkpoint-20260915-luna-post-release-v7.json`
(`bytes=2032`, `sha256=93525acf8a1a46e3b84a7bf069cd0484d9163105bd270764f2c2574e4589224d`).
The proposal's retained v5 verify, package, acceptance, and diff-check gate
records each exit `0`. Those are preparation and artifact-integrity results;
the current v8 records are listed in [Gate state](#gate-state). Neither set
adds measured rows to the blocked 45/18 campaign.

### Authorized v5 execution snapshot (blocked, not a completed campaign)

The immutable v5 stop ledger is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/proposed-series-v5/campaign-1/campaign-stop-ledger.json`
(`sha256=4226c3b53ece6137c8c32b3ba18b687d799aa39b1e955b48b019ea37e3db0e24`).
It records `status=blocked`, `no_retry=true`, two started cells out of 15,
and no next cell. The baseline manifest records `model_invoked=true`, which
means the Codex process was launched; its retained transcript is empty, its
timing sidecar exposes one observed turn and zero MCP/command calls, and its
token, cost, correctness, coverage, efficiency, and distribution measurements
are `null`. This does not establish a successful model interaction. The
Urdira cell returned exit 1 without a manifest or preflight-failure artifact;
its `model_invoked` value is therefore `null` and its status is `blocked`.
The remaining 43 cells are `not_attempted`. All 18 readiness probes are
`blocked` before execution, with all readiness measurements `null`.

The complete 45-cell/18-probe state table is preserved externally at
`/Users/Cristian/BenchmarkResults/urdira-renderer-analysis-revision-20260915/partial-plan-table-v2.json`
(`sha256=a9cd99468a8c078f4358a30182a1ab8eeeb584406faea4cd39ecfba77094f4a4`).
The renderer analysis revision and preservation record are
`/Users/Cristian/BenchmarkResults/urdira-renderer-analysis-revision-20260915/analysis-revision-v3.json`
(`sha256=369f5bdd9c42bc7f9997c5d089f93d13778a48ee49463e5a27ba22dbc42441f7`);
this revision is separate from the v5 measurement freeze and raw artifacts.

Offline analysis was run only on the retained empty baseline transcript:

```bash
RAW_TRANSCRIPT="/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/proposed-series-v5/campaign-1/runs/playwright-affected-tests-deterministic-baseline-1/playwright-affected-tests-deterministic-baseline-1.jsonl"
CAMPAIGN_1_AUDIT="/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/proposed-series-v5/campaign-1/campaign-audit.json"
DERIVED="/Users/Cristian/BenchmarkResults/urdira-renderer-analysis-revision-20260915"
node release/benchmarks/analyze-agent-matched.mjs "$RAW_TRANSCRIPT" \
  > "$DERIVED/baseline-token-analysis-v2.json"
node release/benchmarks/render-expanded-agent-report.mjs \
  --audit "$CAMPAIGN_1_AUDIT" \
  --output "$DERIVED/campaign-1-partial-render-v2"
```

The analyzer output SHA is
`32fb4fbc45e969c3969a6da1164972259a835e9f169990d65cf17ecfb2e5f361`.
The partial renderer outputs have SHAs
`8bc8421d949d94084f08d4e6053ae0ebb7d566528a3e1039d980191d90cb5467`
(JSON) and
`92f93c6a48e653b0d3e8165338261813c57548621efe86a57e001664f6997873`
(Markdown). That render observed 2 of 15 cells, 0 successful, 2 failed or
blocked, and 0 of 6 readiness probes; its gate is false. It is explicitly a
partial diagnostic and cannot satisfy the selected-45 renderer requirement of
45 cells and 18 probes.

### Planned 45 agent cells

The table is complete for the frozen 3 campaigns × 3 repository/task pairs ×
5 arms. It is a plan and blocked-result ledger, not evidence that all cells
ran. Two campaign-1 cells were attempted: one failed with a retained
manifest, and one was blocked without a manifest; 43 cells were not attempted.
Unavailable measurements are `null`.

| Campaign | Repository / task | Arm | Model execution | Measurements |
|---:|---|---|---:|---|
| 1 | Playwright / `affected-tests-deterministic` | `baseline` | process launched; failed (`model_invoked=true`) | retained manifest; one timing turn, zero MCP/command calls; token and other unavailable measurements `null` |
| 1 | Playwright / `affected-tests-deterministic` | `urdira-typescript` | blocked; `model_invoked=null` | exit 1 without manifest; all measurements `null` |
| 1 | Playwright / `affected-tests-deterministic` | `tgrep` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 1 | Playwright / `affected-tests-deterministic` | `codegraph` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 1 | Playwright / `affected-tests-deterministic` | `codebase-memory` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 1 | Prisma / `wire-name-validation` | `baseline` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 1 | Prisma / `wire-name-validation` | `urdira-typescript` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 1 | Prisma / `wire-name-validation` | `tgrep` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 1 | Prisma / `wire-name-validation` | `codegraph` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 1 | Prisma / `wire-name-validation` | `codebase-memory` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 1 | VS Code / `language-provider-registration-idempotence` | `baseline` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 1 | VS Code / `language-provider-registration-idempotence` | `urdira-typescript` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 1 | VS Code / `language-provider-registration-idempotence` | `tgrep` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 1 | VS Code / `language-provider-registration-idempotence` | `codegraph` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 1 | VS Code / `language-provider-registration-idempotence` | `codebase-memory` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 2 | Playwright / `affected-tests-deterministic` | `baseline` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 2 | Playwright / `affected-tests-deterministic` | `urdira-typescript` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 2 | Playwright / `affected-tests-deterministic` | `tgrep` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 2 | Playwright / `affected-tests-deterministic` | `codegraph` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 2 | Playwright / `affected-tests-deterministic` | `codebase-memory` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 2 | Prisma / `wire-name-validation` | `baseline` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 2 | Prisma / `wire-name-validation` | `urdira-typescript` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 2 | Prisma / `wire-name-validation` | `tgrep` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 2 | Prisma / `wire-name-validation` | `codegraph` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 2 | Prisma / `wire-name-validation` | `codebase-memory` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 2 | VS Code / `language-provider-registration-idempotence` | `baseline` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 2 | VS Code / `language-provider-registration-idempotence` | `urdira-typescript` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 2 | VS Code / `language-provider-registration-idempotence` | `tgrep` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 2 | VS Code / `language-provider-registration-idempotence` | `codegraph` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 2 | VS Code / `language-provider-registration-idempotence` | `codebase-memory` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 3 | Playwright / `affected-tests-deterministic` | `baseline` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 3 | Playwright / `affected-tests-deterministic` | `urdira-typescript` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 3 | Playwright / `affected-tests-deterministic` | `tgrep` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 3 | Playwright / `affected-tests-deterministic` | `codegraph` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 3 | Playwright / `affected-tests-deterministic` | `codebase-memory` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 3 | Prisma / `wire-name-validation` | `baseline` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 3 | Prisma / `wire-name-validation` | `urdira-typescript` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 3 | Prisma / `wire-name-validation` | `tgrep` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 3 | Prisma / `wire-name-validation` | `codegraph` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 3 | Prisma / `wire-name-validation` | `codebase-memory` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 3 | VS Code / `language-provider-registration-idempotence` | `baseline` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 3 | VS Code / `language-provider-registration-idempotence` | `urdira-typescript` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 3 | VS Code / `language-provider-registration-idempotence` | `tgrep` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 3 | VS Code / `language-provider-registration-idempotence` | `codegraph` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |
| 3 | VS Code / `language-provider-registration-idempotence` | `codebase-memory` | not attempted; `model_invoked=null` | not attempted; campaign blocked; all measurements `null` |

### Planned 18 readiness probes

Readiness is a separate 3 campaigns × 3 repositories × cold/warm matrix. No
probe ran and every readiness measurement is absent (`null`).

| Campaign | Repository | Phase | Model execution | Measurement |
|---:|---|---|---:|---|
| 1 | Playwright | `cold` | blocked before probe | all readiness fields `null` |
| 1 | Playwright | `warm` | blocked before probe | all readiness fields `null` |
| 1 | Prisma | `cold` | blocked before probe | all readiness fields `null` |
| 1 | Prisma | `warm` | blocked before probe | all readiness fields `null` |
| 1 | VS Code | `cold` | blocked before probe | all readiness fields `null` |
| 1 | VS Code | `warm` | blocked before probe | all readiness fields `null` |
| 2 | Playwright | `cold` | not attempted | not run; all readiness fields `null` |
| 2 | Playwright | `warm` | not attempted | not run; all readiness fields `null` |
| 2 | Prisma | `cold` | not attempted | not run; all readiness fields `null` |
| 2 | Prisma | `warm` | not attempted | not run; all readiness fields `null` |
| 2 | VS Code | `cold` | not attempted | not run; all readiness fields `null` |
| 2 | VS Code | `warm` | not attempted | not run; all readiness fields `null` |
| 3 | Playwright | `cold` | not attempted | not run; all readiness fields `null` |
| 3 | Playwright | `warm` | not attempted | not run; all readiness fields `null` |
| 3 | Prisma | `cold` | not attempted | not run; all readiness fields `null` |
| 3 | Prisma | `warm` | not attempted | not run; all readiness fields `null` |
| 3 | VS Code | `cold` | not attempted | not run; all readiness fields `null` |
| 3 | VS Code | `warm` | not attempted | not run; all readiness fields `null` |

### Historical offline appendix (separate from the blocked campaign)

The retained 47-run offline replay is not campaign evidence and is not mixed
with the planned table above. It covers the raw association inventory only:
47 rows, 40 runs with matched host token evidence, 7 without host evidence,
34 successful historical outcomes, and 13 failed/blocked outcomes. Its
readiness count is 0 and it cannot establish the definitive 45/18 protocol.
The v6 artifacts are retained at
`/Users/Cristian/BenchmarkResults/urdira-definitive-offline-20260915-metrics-final-v6`:

| Artifact | SHA-256 |
|---|---|
| `replay.json` | `687f7ce902a6d02a09514463d1755c48c6358757db3bb2bd6f9ea6561de13c5c` |
| `analyzer-manifest.json` | `af55eec4d31e49c72cddddf8c61fd31634965ab2aef5e97d053a039785de0131` |
| `audit.json` | `11a33fdf2cda7fcc46a4f859705ad5e6ea2a30b2a04e5bfe4fc20894429e0cf8` |
| `report.json` | `6aeb89b0f9738259ce28e7f224649b07de2579aff7db987524a6092a45836248` |
| `report.md` | `b4dbca9b055e94658ac72d10f37dcc7cf1bb0a06517fee39f0a6e31662b7d577` |
| `artifact-hashes.json` | `7e10a33b056d2868572085c9a75db622767bb24622dfac2f3fa4c5aabca625ab` |

The raw association inventory is
`/Users/Cristian/BenchmarkResults/urdira-context-raw-association-20260915.json`
(`sha256=f71e27fb7c7665efc780f5a11b2a70faadc2d7e26706570ac13a9e5d33661e13`).
The offline replay input and normalized manifest hashes are
`1b1e5abc254d88582cd9e2df852d8158a309e94aec74c74ddb57f382572383bb` and
`2053a46edd1fa0992a36d426088221ffe5a4d5f140fb470c751fb6c3049187c1`.

### Gate state

The current v8 repository, package, acceptance, and diff-check gates all exit
`0`. Their retained records are:

| Gate | Exit SHA-256 | stdout log SHA-256 | stderr log SHA-256 |
|---|---|---|---|
| `pnpm verify` | `9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa` | `adcb5d4078644907dac388606828ad9c7af119a140fcd1c1569866c3cf38d96e` | `2293a8217f4f0912132672b3148c0b66a9c14efe7d15e9776a5235490a2ce430` |
| `pnpm package:release` | `9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa` | `07efd646a402b386c8b4b54d60a525bd665998e9f26074cb631009b52abaf5bc` | `ea66be16e7e8d99813ccbe29de831ed1a434fa5ed0fe84885d5972795dd56d36` |
| `pnpm release:acceptance` | `9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa` | `75e7679588e35d6848a279372662a6f1e0cb78e2aa4a4ea797a1b5eb928b1879` | `62ebcde7919e6bb90c422dad33e37186b824101f687188029ab75bc90f42580e` |
| `git diff --check` | `9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

The files are retained under
`/Users/Cristian/BenchmarkResults/urdira-gates-20260915-v8/` with the names
`{verify,package,acceptance,diff-check}.{exit,stdout.log,stderr.log}`. The
earlier v7 `pnpm verify` record remains historical: it exited `1` because
`tests/expanded-benchmark-smoke.test.ts:181` expected an outdated runner
snippet; its exit SHA is
`4355a46b19d348dc2f57c046f8ef63d4538ebb936000f3c9ee954a27460dd865`.
These historical v8 gate records predate the post-campaign PATH fix. They
validate repository and release artifacts only and add no benchmark
measurements. The v8 matrix is closed with retained failures; readiness remains
unqualified, and no current gate result is claimed here.
The current post-campaign PATH-fix gate record is
`/Users/Cristian/BenchmarkResults/urdira-definitive-campaign-20260915/series-v8/runner-path-fix-v2/gates-final-manifest-v2.json`
(SHA-256 `b9d170bed887bf06b2522a8b956a9434fb65d9d1909734052cab31af17cbd9ed`).
The gate run recorded repository HEAD
`b05bf226a78d5290807c92c21874d5d858b69c7b` with the PATH-fix working-tree
changes present before commit; a later commit must retain this evidence
separately.
Its `verify-v2.log` passed with 90.06% total coverage and 100% critical branch
coverage (SHA-256 `67143321d7e22fe2a9987272066d7cc7185699cb65d6df89950236a62b6a00cf`);
`package-release-v1.log` passed (SHA-256
`9a7b52db801bd734b6c4f4bf0d1e5fefdfe945d99d8f21800821fe0a53098665`),
`release-acceptance-v1.log` passed (SHA-256
`51e6b3d4489cdf093fdcea4ea60f92563204a73aa9ec8e1b34bb0918a5e2217a`), and
`diff-check-v1.log` passed (SHA-256
`53da44f38c61ac33d12c2f6799955f61db476c8aa34f89e02014d056e19db329`).
These are repository and release checks only; they add no benchmark or
readiness measurements and do not retroactively validate readiness.
The post-gate cleanup chain is recorded by `global-cleanup-v1.json` (SHA-256
`b324a69d173d557d42e644acb8d323303e94a99cd864fcfa1c8689d5cd7aa74c`),
`global-cleanup-v2.json` (SHA-256
`7761773e8cd776fc3fa95b9a87f73163f925f62747ad2cb1e552f2172ce86bae`), and
`global-cleanup-v3.json` (SHA-256
`e6d0cccd6df033e358277ac1492a7acbf0e1472400a2bc94d4d221771917bf97`), with
zero active processes after v3 and 56,735 bytes of declared temporary files
removed. The retained pre-gate, post-package, and post-acceptance archives
are respectively 183,787,326 bytes (SHA-256
`1b4fc4f064962206f1556242e946b53390aba08edf86232e646f3a296e4a4dd6`),
183,788,002 bytes (SHA-256
`d6e0e92f827ed6973516fa338b255c9d30b9269f43b2791e2a3fdc14a8bdb5ef`), and
183,788,113 bytes (SHA-256
`4f30c892880154a903a1c4685803f588b781bcabfe2faf49953e37cf319fef60`).
The final cleanup checkpoint is
`/Users/Cristian/BenchmarkResults/urdira-phase0-cleanup-checkpoint-20260915-luna-post-gates-v10.json`
(`sha256=6be8cb16b6a5aa6459f99f5fbf81faecd25bbf9be2a74575c24542dad2883eec`):
free bytes were `367785205760` against the `53687091200` threshold, with zero
owned processes and zero residue; three source clones, their dependency roots,
and two extraction roots were deleted. Raw data, the archive, release-binding
metadata, and frozen harness metadata were retained. The v5 proposal and
preflight artifacts are historical evidence, not current readiness; a new
execution would require reprovisioning and a new freeze.
