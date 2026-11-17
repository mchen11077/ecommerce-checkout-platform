# Coupon coursework: build, start, run all experiments, write results\summary.md
$ErrorActionPreference = "Continue"   # native tools (docker) write progress to stderr; we check $LASTEXITCODE instead
Set-Location $PSScriptRoot

# Keep the previous run: results\ is moved to results_prev_<time>\ before starting.
if (Test-Path "results\summary.md") {
  $prev = "results_prev_" + (Get-Item "results\summary.md").LastWriteTime.ToString("yyyyMMdd_HHmm")
  if (-not (Test-Path $prev)) { Move-Item "results" $prev } else { Remove-Item "results" -Recurse -Force }
}
New-Item -ItemType Directory -Force results | Out-Null
Start-Transcript -Path "results\run_log.txt" -Force | Out-Null
$api = "http://localhost:8080/api"
$summary = "results\summary.md"
$env:CONSUMER_BATCH = "false"

function Say($msg) { Write-Host ""; Write-Host "==== $msg" -ForegroundColor Cyan }
function Out-Md($line) { Add-Content -Path $summary -Value $line -Encoding UTF8 }

Say "Checking Docker engine"
docker info > $null 2>&1
if ($LASTEXITCODE -ne 0) { Write-Host "Docker engine is not running. Start Docker Desktop, wait until it says 'Engine running', then run again." -ForegroundColor Red; Stop-Transcript | Out-Null; exit 1 }

Say "Removing old containers and data, then building and starting (first run downloads images, can take 5-10 min)"
docker compose --profile test down -v --remove-orphans
docker compose up -d --build
if ($LASTEXITCODE -ne 0) { Stop-Transcript | Out-Null; throw "docker compose up failed (if this is a Java compile error, send me results\run_log.txt)" }
docker compose --profile test pull k6

function Wait-App {
  for ($i = 0; $i -lt 120; $i++) {
    try { $h = Invoke-RestMethod "http://localhost:8080/actuator/health" -TimeoutSec 3; if ($h.status -eq "UP") { Start-Sleep 10; return } } catch {}
    Start-Sleep 3
  }
  docker compose logs app > results\app_log.txt
  throw "App did not start; see results\app_log.txt"
}
Say "Waiting for the app to become healthy"
Wait-App   # includes 10 s for Kafka to elect a leader and the consumer group to settle

function New-Coupon($name, $stock, $extra) {
  $b = @{ name = $name; stock = $stock }
  if ($extra) { foreach ($k in $extra.Keys) { $b[$k] = $extra[$k] } }
  $c = Invoke-RestMethod -Method Post "$api/coupons" -ContentType "application/json" -Body ($b | ConvertTo-Json)
  return $c.id
}
function Issue-Coupon($id) { Invoke-RestMethod -Method Post "$api/coupons/$id/issue" | Out-Null }
function New-IssuedCoupon($name, $stock) { $id = New-Coupon $name $stock $null; Issue-Coupon $id; return $id }
function Get-Stats($id) { Invoke-RestMethod "$api/coupons/$id/stats" }
function Run-K6($script, $envs) {
  $a = @("compose", "--profile", "test", "run", "--rm", "k6", "run", "--quiet")
  foreach ($k in $envs.Keys) { $a += @("-e", "$k=$($envs[$k])") }
  $a += "/scripts/$script"
  & docker @a | Out-Host
}
function Read-K6($name) { Get-Content "results\$name.json" -Raw | ConvertFrom-Json }
function M($j, $metric, $field) { $m = $j.metrics.$metric; if ($null -eq $m) { return 0 }; return $m.values.$field }
# HTTP call that returns status code + "result" field, also for 4xx answers
function Call($method, $url) {
  try {
    $r = Invoke-WebRequest -Method $method $url -UseBasicParsing -TimeoutSec 10
    return @{ code = [int]$r.StatusCode; result = ($r.Content | ConvertFrom-Json).result }
  } catch {
    $resp = $_.Exception.Response
    if ($null -eq $resp) { return @{ code = 0; result = "NO_RESPONSE" } }
    $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
    try { $reader.BaseStream.Position = 0 } catch {}
    $text = $reader.ReadToEnd()
    $res = "?"; try { $res = ($text | ConvertFrom-Json).result } catch {}
    return @{ code = [int]$resp.StatusCode; result = $res }
  }
}
# Wait until the Kafka consumer has persisted every claim Redis accepted. Returns seconds waited (-1 = gave up).
function Wait-Persisted($id, $maxSeconds) {
  $t0 = Get-Date
  while (((Get-Date) - $t0).TotalSeconds -lt $maxSeconds) {
    $s = Get-Stats $id
    if ($s.dbClaims -ge $s.redisClaimed) { return [math]::Round(((Get-Date) - $t0).TotalSeconds, 0) }
    Start-Sleep 2
  }
  return -1
}

# ---- Machine info ----
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$memGb = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
Set-Content -Path $summary -Value "# Coupon coursework results" -Encoding UTF8
Out-Md ""
Out-Md "- Run at: $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
Out-Md "- Machine: $($cpu.Name), $($cpu.NumberOfCores) cores / $($cpu.NumberOfLogicalProcessors) threads, $memGb GB RAM"
Out-Md "- Everything (app, PostgreSQL, Redis, Kafka, k6 load generator) runs in Docker Desktop on this one machine."
if ($prev) { Out-Md "- Previous run kept in: $prev\" }
Out-Md ""

# ---- Experiment 1: overselling (Step 1.3 / 2.1 / 3.3) ----
Say "Experiment 1: 100 users claim a coupon with stock = 1"
Out-Md "## Experiment 1 - Overselling: 100 concurrent users, stock = 1"
Out-Md ""
Out-Md "| Mode | HTTP 200 (told 'you got it') | Claims in DB | DB stock after | Redis stock after | Oversold? |"
Out-Md "|---|---|---|---|---|---|"
foreach ($mode in @("naive", "lock", "redis")) {
  $id = New-IssuedCoupon "oversell-$mode" 1
  Run-K6 "oversell.js" @{ MODE = $mode; COUPON_ID = $id; USERS = 100; NAME = "e1_$mode" }
  Start-Sleep 5
  $s = Get-Stats $id
  $okCount = M (Read-K6 "e1_$mode") "claim_ok" "count"
  $over = if ($s.dbClaims -gt 1 -or $okCount -gt 1) { "YES" } else { "no" }
  Out-Md "| $mode | $okCount | $($s.dbClaims) | $($s.dbStock) | $($s.redisStock) | $over |"
}
Out-Md ""

# ---- Experiment 1b: coupon lifecycle - issue, claim, eligibility, redeem (Step 1.1) ----
Say "Experiment 1b: coupon lifecycle (issue / claim / eligibility / redeem)"
Out-Md "## Experiment 1b - Coupon lifecycle: issue, claim, eligibility validation, redemption (Step 1.1)"
Out-Md ""
Out-Md "| # | Action | Expected | Got | Pass |"
Out-Md "|---|---|---|---|---|"
$script:step = 0; $script:passed = 0
function Check($action, $expected, $r) {
  $script:step++
  $ok = ($r.result -eq $expected)
  if ($ok) { $script:passed++ }
  $mark = if ($ok) { "yes" } else { "**NO**" }
  Out-Md "| $($script:step) | $action | $expected | $($r.result) (HTTP $($r.code)) | $mark |"
}
function Utc($secondsFromNow) { (Get-Date).ToUniversalTime().AddSeconds($secondsFromNow).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'") }

$a = New-Coupon "lifecycle" 100 @{ minOrderAmount = 100 }
Check "Claim before the coupon is issued" "NOT_ISSUED" (Call Post "$api/coupons/$a/claim?userId=1&mode=redis")
Issue-Coupon $a
Check "Claim after issue (user 1)" "OK" (Call Post "$api/coupons/$a/claim?userId=1&mode=redis")
Check "Same user claims again" "ALREADY_CLAIMED" (Call Post "$api/coupons/$a/claim?userId=1&mode=redis")
Wait-Persisted $a 30 | Out-Null
Check "Eligibility: user 2 never claimed" "NOT_CLAIMED" (Call Get "$api/coupons/$a/eligibility?userId=2&orderAmount=150")
Check "Eligibility: user 1, order 50 < min 100" "BELOW_MIN_ORDER" (Call Get "$api/coupons/$a/eligibility?userId=1&orderAmount=50")
Check "Eligibility: user 1, order 150" "ELIGIBLE" (Call Get "$api/coupons/$a/eligibility?userId=1&orderAmount=150")
Check "Redeem: user 1, order 150" "REDEEMED" (Call Post "$api/coupons/$a/redeem?userId=1&orderAmount=150&orderId=order-1")
Check "Redeem the same claim again" "ALREADY_REDEEMED" (Call Post "$api/coupons/$a/redeem?userId=1&orderAmount=150&orderId=order-2")

$b = New-Coupon "expires-soon" 100 @{ validUntil = (Utc 6) }
Issue-Coupon $b
Call Post "$api/coupons/$b/claim?userId=1&mode=redis" | Out-Null
Wait-Persisted $b 30 | Out-Null
Start-Sleep 8
Check "Eligibility after valid_until has passed" "EXPIRED" (Call Get "$api/coupons/$b/eligibility?userId=1&orderAmount=150")
Check "Redeem after valid_until has passed" "EXPIRED" (Call Post "$api/coupons/$b/redeem?userId=1&orderAmount=150&orderId=order-3")

$c = New-Coupon "starts-later" 100 @{ validFrom = (Utc 3600) }
Issue-Coupon $c
Call Post "$api/coupons/$c/claim?userId=1&mode=redis" | Out-Null
Wait-Persisted $c 30 | Out-Null
Check "Eligibility before valid_from" "NOT_STARTED" (Call Get "$api/coupons/$c/eligibility?userId=1&orderAmount=150")
Out-Md ""
Out-Md "- Passed $($script:passed) / $($script:step) checks"
Out-Md ""

# Concurrent redemption: 50 requests redeem the same claim at once
$d = New-IssuedCoupon "redeem-race" 100
Call Post "$api/coupons/$d/claim?userId=1&mode=redis" | Out-Null
Wait-Persisted $d 30 | Out-Null
Run-K6 "redeem_race.js" @{ COUPON_ID = $d; USER_ID = 1; ATTEMPTS = 50; NAME = "e1b_redeem_race" }
$race = Read-K6 "e1b_redeem_race"
$sd = Get-Stats $d
Out-Md "**Concurrent redemption** - 50 requests redeem the same claim at the same moment:"
Out-Md ""
Out-Md "| Told 'redeemed' (HTTP 200) | Rejected (HTTP 409) | Other errors | Claims marked REDEEMED in DB | Double redemption? |"
Out-Md "|---|---|---|---|---|"
$raceOk = M $race "redeem_ok" "count"
$double = if ($raceOk -gt 1 -or $sd.dbRedeemed -gt 1) { "YES" } else { "no" }
Out-Md "| $raceOk | $(M $race 'redeem_rejected' 'count') | $(M $race 'redeem_error' 'count') | $($sd.dbRedeemed) | $double |"
Out-Md ""

# ---- Experiment 2: latency / throughput + SQL per request (Step 1.4 / 2.2 / 3.3) ----
Say "Experiment 2: fixed-rate load tests"
Out-Md "## Experiment 2 - Load test (constant arrival rate, 20 s each, unique user per request)"
Out-Md ""
Out-Md "| Mode | Target RPS | Achieved RPS | Requests | Median ms | p95 ms | p99 ms | Error rate | Dropped iterations | Sync SQL / request |"
Out-Md "|---|---|---|---|---|---|---|---|---|---|"

# warm-up JVM
$warm = New-IssuedCoupon "warmup" 100000000
Run-K6 "throughput.js" @{ MODE = "redis"; COUPON_ID = $warm; RATE = 1000; DURATION = "10s"; NAME = "warmup"; USER_OFFSET = 900000000 }
Run-K6 "throughput.js" @{ MODE = "naive"; COUPON_ID = $warm; RATE = 300; DURATION = "10s"; NAME = "warmup2"; USER_OFFSET = 910000000 }

$plan = @(
  @{ mode = "naive"; rates = @(500, 1000, 2000) },
  @{ mode = "lock";  rates = @(500, 1000, 2000) },
  @{ mode = "redis"; rates = @(1000, 5000, 10000, 20000, 30000) }
)
$offset = 0
$lastRedisCoupon = $null
foreach ($p in $plan) {
  foreach ($rate in $p.rates) {
    $offset += 10000000
    $id = New-IssuedCoupon "load-$($p.mode)-$rate" 100000000
    Invoke-RestMethod -Method Post "$api/metrics/sql/reset" | Out-Null
    $name = "e2_$($p.mode)_$rate"
    Say "$($p.mode) @ $rate rps"
    Run-K6 "throughput.js" @{ MODE = $p.mode; COUPON_ID = $id; RATE = $rate; NAME = $name; USER_OFFSET = $offset }
    $sql = (Invoke-RestMethod "$api/metrics/sql").syncSqlCount
    $j = Read-K6 $name
    $reqs = M $j "http_reqs" "count"
    $sqlPer = if ($reqs -gt 0) { [math]::Round($sql / $reqs, 2) } else { 0 }
    $row = "| {0} | {1} | {2:N0} | {3:N0} | {4:N1} | {5:N1} | {6:N1} | {7:P2} | {8} | {9} |" -f `
      $p.mode, $rate, (M $j "http_reqs" "rate"), $reqs, (M $j "http_req_duration" "med"), `
      (M $j "http_req_duration" "p(95)"), (M $j "http_req_duration" "p(99)"), (M $j "http_req_failed" "rate"), `
      (M $j "dropped_iterations" "count"), $sqlPer
    Out-Md $row
    if ($p.mode -eq "redis") { $lastRedisCoupon = $id }
  }
}
Out-Md ""

# ---- Experiment 3: reconciliation after the last redis run (Step 4.3) ----
Say "Experiment 3: waiting for Kafka consumer to persist redis claims"
Out-Md "## Experiment 3 - Redis vs PostgreSQL reconciliation after the last redis run (Step 4.3, per-message consumer)"
Out-Md ""
$secs = Wait-Persisted $lastRedisCoupon 600
$s = Get-Stats $lastRedisCoupon
Out-Md "- Claims accepted in Redis: $($s.redisClaimed); persisted to PostgreSQL: $($s.dbClaims); extra wait after test ended: ~$secs s (-1 = still behind after 600 s)"
Out-Md "- DB stock = $($s.dbStock), Redis stock = $($s.redisStock) (should match once the consumer has caught up)"
Out-Md ""

# ---- Experiment 4: consumer crash and restart (Phase 5 "consumer crash", now measured) ----
Say "Experiment 4: kill the app (and its consumer) while it is catching up, then restart"
Out-Md "## Experiment 4 - Consumer crash and restart (Phase 5, measured)"
Out-Md ""
Out-Md "Redis path at 10,000 RPS for 20 s, then 15 s later the app container is killed with SIGKILL (no graceful shutdown, uncommitted Kafka offsets are lost) and started again."
Out-Md ""
$offset += 10000000
$k = New-IssuedCoupon "crash-restart" 100000000
Run-K6 "throughput.js" @{ MODE = "redis"; COUPON_ID = $k; RATE = 10000; NAME = "e4_load"; USER_OFFSET = $offset }
Start-Sleep 15
$atKill = Get-Stats $k
docker compose kill app
Start-Sleep 3
docker compose start app
Wait-App
$recover = Wait-Persisted $k 600
$after = Get-Stats $k
$cs = Invoke-RestMethod "$api/metrics/consumer"
$valid = if ($atKill.dbClaims -lt $atKill.redisClaimed) { "yes" } else { "NO - consumer had already caught up before the kill; rerun" }
$lost = $after.redisClaimed - $after.dbClaims
$stockOk = if ($after.dbStock -eq $after.redisStock) { "yes" } else { "**NO**" }
Out-Md "| Claims accepted in Redis | Persisted when killed | Persisted after restart | Lost | DB stock = Redis stock | Redelivered events skipped after restart | Recovery wait |"
Out-Md "|---|---|---|---|---|---|---|"
Out-Md "| $($after.redisClaimed) | $($atKill.dbClaims) | $($after.dbClaims) | $lost | $stockOk ($($after.dbStock) / $($after.redisStock)) | $($cs.duplicatesSkipped) | ~$recover s |"
Out-Md ""
Out-Md "- Kill happened while the consumer was still behind: $valid"
Out-Md "- No duplicate rows is guaranteed by the unique (coupon_id, user_id) constraint; matching stock shows redelivered events did not decrement stock twice."
Out-Md ""

# ---- Experiment 5: per-message vs batch consumer (Step 4.4) ----
Say "Experiment 5: per-message vs batch consumer"
Out-Md "## Experiment 5 - Consumer catch-up: per-message vs batch insert (Step 4.4)"
Out-Md ""
Out-Md "Same load for both: Redis path at 10,000 RPS for 20 s. Catch-up = time from the end of the load test until PostgreSQL has every claim."
Out-Md ""
Out-Md "| Consumer mode | Claims | Catch-up after load ends | Consumer throughput (claims / s, whole run) | DB stock = Redis stock | Polls |"
Out-Md "|---|---|---|---|---|---|"
foreach ($batch in @("false", "true")) {
  if ($batch -eq "true") {
    $env:CONSUMER_BATCH = "true"
    docker compose up -d app       # recreates the app container with batch mode on
    Wait-App
  }
  $before = Invoke-RestMethod "$api/metrics/consumer"
  $offset += 10000000
  $id = New-IssuedCoupon "consumer-$batch" 100000000
  Run-K6 "throughput.js" @{ MODE = "redis"; COUPON_ID = $id; RATE = 10000; NAME = "e5_batch_$batch"; USER_OFFSET = $offset }
  $wait = Wait-Persisted $id 600
  $s = Get-Stats $id
  $cs = Invoke-RestMethod "$api/metrics/consumer"
  $tput = if ($wait -ge 0) { [math]::Round($s.dbClaims / (20 + $wait), 0) } else { "n/a" }
  $stockOk = if ($s.dbStock -eq $s.redisStock) { "yes" } else { "**NO**" }
  Out-Md "| $($cs.mode) | $($s.dbClaims) | ~$wait s | $tput | $stockOk | $($cs.polls - $before.polls) |"
}
$env:CONSUMER_BATCH = "false"
Out-Md ""

docker compose logs app > results\app_log.txt
Say "DONE. Results: $PSScriptRoot\results\summary.md"
Stop-Transcript | Out-Null
