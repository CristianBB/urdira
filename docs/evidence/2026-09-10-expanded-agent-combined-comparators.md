# Expanded agent benchmark: tool-assigned comparator campaign with frozen Urdira

This evidence joins the fresh comparator campaigns with the last permitted
Urdira smoke rows. Urdira was not executed in this campaign. Comparator cells
have `n=3` samples per task; frozen Urdira has at most `n=1` per task. Values
are medians over the samples in each cell. The tuple after the success count is
`setup/agent/total` in milliseconds, followed by `tokens; cost USD; repository
reads; context characters; peak process-tree RSS KiB`.

These 96 comparator rows and the frozen Urdira smoke used tool-assigned,
prompt-directed protocols. They remain useful for measuring performance under
forced tool use, but they do not measure whether an agent naturally selects
MCP, Urdira composition, tgrep, or ordinary repository tools. Raw data and
failure rows are preserved unchanged. The updated runner records those choices
observationally for the next campaign.

The comparator source audits are:

- S/M: `.../luna-campaign-20260910T0807/full-comparators-sm-v3/audit.json`, 48 observed, 46 successful, 2 failed.
- L: `.../luna-campaign-20260910T0807/full-comparators-l-v1/audit.json`, 48 observed, 47 successful, 1 failed.
- Frozen Urdira: `.../luna-campaign-20260909T1935/smoke-tgrep-final-v3/audit.json`, 7 observed, 5 successful.

`—` means the failed or absent row did not provide that measurement. Urdira
semantic indexing and materialization are `off` and semantic bytes are `0`
for every frozen row; the failed VS Code row has only its diagnostic RSS.

| Task | baseline (n=3) | codebase-memory (n=3) | codegraph (n=3) | tgrep (n=3) | Urdira frozen (n=1) |
|---|---|---|---|---|---|
| transpile-diagnostic-callback | 3/3; 750/242,124/242,967; 1,299,610; $2.68; 11; 105,169; 298,368 | 3/3; 42,625/317,760/360,277; 2,350,061; $4.80; 49; 294,814; 9,989,552 | 3/3; 81,398/214,990/296,042; 1,299,633; $2.67; 8; 172,016; 5,019,104 | 3/3; 5,004/268,730/273,544; 1,282,504; $2.65; 3; 96; 290,112 | 1/1; 23,905/265,357/289,262; 1,657,800; $3.41; 21; 57,801; 4,136,912; sem=0 |
| session-project-event-hook | 3/3; 680/305,610/306,290; 1,588,548; $3.28; 16; 162,183; 320,576 | 3/3; 42,767/396,178/441,990; 3,732,897; $7.60; 40; 1,257,470; 8,057,008 | 3/3; 81,681/334,577/416,258; 3,193,125; $6.50; 11; 246,070; 5,005,632 | 3/3; 5,289/349,535/354,824; 1,891,920; $3.91; 4; 312; 303,920 | 1/1; 23,717/419,650/443,367; 2,371,851; $4.90; 22; 57,030; 4,107,184; sem=0 |
| affected-tests-deterministic | 3/3; 831/201,111/201,278; 628,159; $1.31; 15; 86,149; 258,608 | 2/3; 5,331/187,279/166,669; 1,378,697; $2.82; 28; 153,270; 1,299,024 | 3/3; 10,203/205,510/215,459; 864,960; $1.80; 4; 45,985; 2,559,920 | 2/3; 1,086/248,194/249,148; 1,089,350; $2.27; 4; 143; 273,392 | 1/1; 7,966/214,269/222,235; 1,360,556; $2.78; 12; 41,094; 3,891,872; sem=0 |
| reporter-error-isolation | 3/3; 204/267,721/267,925; 1,201,927; $2.51; 11; 630,967; 310,176 | 3/3; 5,466/269,190/273,914; 1,731,180; $3.55; 38; 140,065; 1,257,216 | 3/3; 10,760/217,863/228,397; 726,581; $1.54; 4; 88,908; 2,525,888 | 3/3; 609/259,001/259,775; 1,038,725; $2.19; 3; 301; 265,184 | 0/1; 7,541/371,156/378,697; 2,578,511; $5.28; 20; 137,127; 3,842,864; sem=0 |
| wire-name-validation | 3/3; 403/201,785/201,898; 882,221; $1.84; 10; 109,937; 287,744 | 3/3; 8,154/213,349/221,503; 1,454,280; $2.99; 24; 224,453; 2,185,664 | 3/3; 10,988/196,313/207,660; 1,214,194; $2.50; 6; 117,441; 2,857,856 | 3/3; 844/241,267/242,111; 1,078,133; $2.25; 4; 2,777; 363,296 | 1/1; 51,876/179,845/231,721; 1,312,939; $2.69; 7; 58,557; 5,734,304; sem=0 |
| mongo-value-set-transform | 3/3; 739/164,314/165,064; 858,014; $1.76; 12; 99,084; 278,688 | 3/3; 7,883/189,066/196,548; 1,465,084; $3.00; 30; 185,644; 2,209,440 | 3/3; 11,505/168,474/180,086; 997,540; $2.05; 6; 129,028; 2,902,448 | 3/3; 894/225,757/227,121; 1,204,650; $2.48; 4; 552; 386,992 | 1/1; 53,313/155,610/208,923; 818,021; $1.69; 5; 38,363; 5,905,088; sem=0 |
| language-registry-change-notification | 3/3; 367/270,829/272,201; 1,547,403; $3.20; 14; 182,414; 297,664 | 3/3; 78,404/425,231/503,635; 2,855,078; $5.85; 32; 275,398; 7,146,960 | 3/3; 76,130/334,954/411,404; 1,893,638; $3.91; 9; 197,164; 7,401,856 | 3/3; 2,749/386,946/390,520; 1,403,952; $2.96; 5; 403; 5,018,320 | 0/1; —/—/—; —; $—; —; —; 17,734,208; sem=0 |
| language-provider-registration-idempotence | 3/3; 1,026/232,814/233,047; 1,193,155; $2.48; 14; 167,517; 283,664 | 3/3; 75,043/262,273/337,316; 1,938,561; $3.96; 42; 238,791; 9,038,928 | 2/3; 76,472/241,448/317,920; 1,430,741; $2.95; 7; 137,625; 7,072,400 | 3/3; 3,158/243,555/246,967; 1,011,210; $2.11; 4; 347; 282,192 | 0/0; —/—/—; —; $—; —; —; —; sem=0 |
| **Agregado observado** | 24/24; 707/242,393/243,003; 1,103,085; $2.30; 13; 127,297; 291,032 | 23/24; 42,517/269,190/317,499; 1,938,561; $3.94; 34; 271,208; 4,621,000 | 23/24; 43,757/222,778/286,983; 1,245,245; $2.57; 7; 134,818; 3,929,184 | 23/24; 2,516/259,001/254,594; 1,237,874; $2.58; 4; 312; 307,312 | 5/7; 23,811/239,813/260,492; 1,509,178; $3.10; 16; 57,416; 4,136,912; sem=0 |

The Urdira aggregate is over its seven observed frozen rows. The missing
`language-provider-registration-idempotence` row was never imputed. Its
`language-registry-change-notification` row reached structural readiness but
failed before a manifest after the large incremental pass; its process-tree
RSS is retained as a diagnostic. The frozen Urdira run contains structural
readiness and inter-turn reconcile data, but no per-query latency and no
pipeline/recipe campaign measurement; it must be read with that limitation.

## Failure inventory

- S/M comparator campaign: `playwright/affected-tests-deterministic`, codebase-memory sample 1; `playwright/affected-tests-deterministic`, tgrep sample 2. Both have preserved process/closure failures.
- L comparator campaign: `vscode/language-provider-registration-idempotence`, codegraph sample 2. The other 47 L rows passed.
- Frozen Urdira: `playwright/reporter-error-isolation` failed grader; `vscode/language-registry-change-notification` produced no manifest after the large incremental pass; the provider task has no frozen row.

## Reproducibility

- tgrep: Microsoft `tgrep` v1.0.5, commit `d55b022023518646c90742f4761488dc95633b73`, binary SHA-256 `231b4d1c835df8d257f36af400a466617c3b6bd6b42e34fa0a244e779aa235d9`.
- Comparator full L audit SHA-256: `684c973e59e4f4adf8d99b62ddf92d078c6c77cf6ae37ae330c72a2b40d89945`.
- Comparator full L JSON report SHA-256: `f1890b9286fa13201979ac188f4851cc9053e61e1cac8177e6aa83be7ecb50af`.
- Comparator full L Markdown report SHA-256: `2cde0090d3c03b71326481f7c3451da00c06fc060c79c7989213f63f85534a88`.
