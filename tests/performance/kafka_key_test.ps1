# Kafka key A/B: key = couponId (one hot partition) vs key = userId (spread over all partitions).
# Same single instance, same 12 partitions, same 6 listener threads; only the key changes.
# Measures per-partition message distribution and consumer catch-up time.
param(
  [int]$Seconds = 15,
  [int]$Rate = 10000,
  [string]$Batch = "false"
)
$ErrorActionPreference = "Continue"
Set-Location (Join-Path $PSScriptRoot '../..')
$out = "tests\performance\out"
New-Item -ItemType Directory -Force $out | Out-Null
$env:CONSUMER_BATCH = $Batch

function Wait-App {
  for ($i = 0; $i -lt 120; $i++) {
    try { $h = Invoke-RestMethod "http://localhost:8080/actuator/health" -TimeoutSec 2; if ($h.status -eq "UP") { Start-Sleep 8; return } } catch {}
    Start-Sleep 2
  }
  throw "app did not become healthy"
}
function Get-Stats($id) { Invoke-RestMethod "http://localhost:8080/api/coupons/$id/stats" }
function Wait-Persisted($id, $maxSeconds) {
  $t0 = Get-Date
  while (((Get-Date) - $t0).TotalSeconds -lt $maxSeconds) {
    $s = Get-Stats $id
    if ($s.dbClaims -ge $s.redisClaimed) { return [math]::Round(((Get-Date) - $t0).TotalSeconds, 1) }
    Start-Sleep 2
  }
  return -1
}
function Get-Offsets {
  $lines = & docker exec coupon-coursework-kafka-1 /opt/kafka/bin/kafka-get-offsets.sh `
    --bootstrap-server localhost:9092 --topic coupon-claimed 2>$null
  $m = @{}
  foreach ($l in $lines) {
    $p = $l -split ':'
    if ($p.Count -eq 3) { $m[[int]$p[1]] = [long]$p[2] }
  }
  return $m
}

Write-Host "== resetting the stack"
docker compose down -v --remove-orphans 2>&1 | Out-Null
docker compose up -d --build 2>&1 | Out-Host
Wait-App

$rows = @()
$offset = 0
foreach ($mode in @("coupon", "user")) {
  $env:KAFKA_KEY_MODE = $mode
  Write-Host "== key mode = $mode"
  docker compose up -d app 2>&1 | Out-Null
  Wait-App
  $offset += 10000000
  $coupon = (Invoke-RestMethod -Method Post "http://localhost:8080/api/coupons" -ContentType "application/json" `
      -Body (@{ name = "key-$mode"; stock = 100000000 } | ConvertTo-Json)).id
  Invoke-RestMethod -Method Post "http://localhost:8080/api/coupons/$coupon/issue" | Out-Null

  $before = Get-Offsets
  $name = "kafka_${mode}_$Batch"
  $a = @("compose", "run", "--rm", "-e", "COUPON_ID=$coupon", "-e", "RATE=$Rate",
    "-e", "DURATION=${Seconds}s", "-e", "NAME=$name", "-e", "USER_OFFSET=$offset",
    "-e", "MODE=redis", "-e", "VUS=1000", "-e", "MAXVUS=8000", "k6", "run", "--quiet", "/scripts/throughput.js")
  & docker @a | Out-Host
  Start-Sleep 2
  $after = Get-Offsets
  $wait = Wait-Persisted $coupon 600
  $s = Get-Stats $coupon
  $cs = Invoke-RestMethod "http://localhost:8080/api/metrics/consumer"
  $j = Get-Content "results\$name.json" -Raw | ConvertFrom-Json
  Move-Item "results\$name.json" "$out\$name.json" -Force

  $parts = @()
  foreach ($p in ($after.Keys | Sort-Object)) {
    $d = $after[$p] - $before[$p]
    if ($d -gt 0) { $parts += "p${p}:$d" }
  }
  $nonEmpty = ($parts | Where-Object { $_ -notmatch ':0$' }).Count
  $rows += [pscustomobject]@{
    mode = $mode
    achieved = [math]::Round($j.metrics.http_reqs.values.rate, 0)
    claims = $s.redisClaimed
    catchUp = $wait
    partitionsUsed = $nonEmpty
    distribution = ($parts -join ", ")
    consumerMode = $cs.mode
    polls = $cs.polls
    inserted = $cs.inserted
    duplicates = $cs.duplicatesSkipped
  }
  Write-Host ("   {0}: {1} claims, catch-up {2}s, {3} partitions used" -f $mode, $s.redisClaimed, $wait, $nonEmpty)
}

$rows | Export-Csv "$out\kafka_key.csv" -NoTypeInformation -Encoding UTF8
$md = @("# Kafka key A/B (consumer $Batch)", "",
  "- 1 app instance, 12 partitions, 6 listener threads, ${Rate} rps for ${Seconds}s per run.",
  "- key=couponId puts every event of the hot coupon on ONE partition, so 5 of 6 listener threads idle.",
  "- key=userId spreads the same coupon over all partitions; the consumer is idempotent and stock decrement is commutative, so ordering per coupon is not needed.",
  "",
  "| Key | Achieved RPS | Claims | Partitions carrying messages | Catch-up s | Consumer mode | Polls | Inserted | Duplicates skipped |",
  "|---|---|---|---|---|---|---|---|---|")
foreach ($r in $rows) {
  $md += "| $($r.mode) | $($r.achieved) | $($r.claims) | $($r.partitionsUsed) | $($r.catchUp) | $($r.consumerMode) | $($r.polls) | $($r.inserted) | $($r.duplicates) |"
}
$md += ""
foreach ($r in $rows) { $md += "- $($r.mode): $($r.distribution)" }
$md | Set-Content "$out\kafka_key_$Batch.md" -Encoding UTF8
Write-Host "== wrote $out\kafka_key_$Batch.md"
