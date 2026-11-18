# Hot-path A/B at a fixed CPU budget: merged Lua (1 round trip vs 2) x virtual threads.
# One replica capped at 2 vCPUs, consumer stopped, closed-loop 1600 VUs (capacity, not a VU cap).
param(
  [int]$Seconds = 30,
  [int]$VUs = 1600
)
$ErrorActionPreference = "Continue"
Set-Location (Join-Path $PSScriptRoot '../..')
$out = "tests\performance\out"
New-Item -ItemType Directory -Force $out | Out-Null
$compose = @("-f", "docker-compose.yml", "-f", "deploy/docker-compose.scale.yml")
$env:CONSUMER_AUTO_STARTUP = "false"

function Compose { & docker compose @compose @args }
function Wait-App {
  for ($i = 0; $i -lt 180; $i++) {
    try { $h = Invoke-RestMethod "http://localhost:8080/actuator/health" -TimeoutSec 2; if ($h.status -eq "UP") { return } } catch {}
    Start-Sleep 2
  }
  throw "app did not become healthy"
}
function EvalshaCalls {
  $info = & docker exec coupon-coursework-redis-1 redis-cli INFO commandstats 2>$null
  $line = $info | Select-String "cmdstat_evalsha:calls=(\d+)"
  if ($line -and $line.Matches.Count -gt 0) { return [long]$line.Matches[0].Groups[1].Value }
  return 0
}
function Load($name, $seconds) {
  $a = @("compose") + $compose + @("run", "--rm",
    "-e", "COUPON_ID=$script:coupon", "-e", "NAME=$name", "-e", "USER_OFFSET=$script:offset",
    "-e", "MODE=redis", "-e", "VUS=$VUs", "-e", "DURATION=${seconds}s",
    "k6", "run", "--quiet", "/scripts/capacity.js")
  $p = Start-Process docker -ArgumentList $a -NoNewWindow -PassThru `
    -RedirectStandardOutput "$out\k6_$name.log" -RedirectStandardError "$out\k6_${name}_err.log"
  $samples = @()
  while (-not $p.HasExited) {
    $line = docker stats --no-stream --format "{{.Name}}|{{.CPUPerc}}"
    foreach ($l in $line) {
      $parts = $l -split '\|'
      if ($parts.Count -ge 2) {
        $samples += [pscustomobject]@{ name = $parts[0]; cpu = [double](($parts[1] -replace '%', '') -replace ',', '.') / 100 }
      }
    }
    Start-Sleep -Milliseconds 1200
  }
  $p.WaitForExit()
  $samples | Export-Csv "$out\stats_$name.csv" -NoTypeInformation -Encoding UTF8
  return $samples
}

Write-Host "== resetting the stack"
Compose down -v 2>&1 | Out-Null
$env:COMBINED_RATE_LIMIT = "true"; $env:VIRTUAL_THREADS = "false"
Compose up -d --build --scale app=1 2>&1 | Out-Host
Wait-App
$script:coupon = (Invoke-RestMethod -Method Post "http://localhost:8080/api/coupons" -ContentType "application/json" `
    -Body (@{ name = "hotpath"; stock = 100000000 } | ConvertTo-Json)).id
Invoke-RestMethod -Method Post "http://localhost:8080/api/coupons/$($script:coupon)/issue" | Out-Null

$rows = @()
$script:offset = 0
$configs = @(
  @{ name = "two-call+platform"; combined = "false"; virtual = "false" },
  @{ name = "merged+platform"; combined = "true"; virtual = "false" },
  @{ name = "two-call+virtual"; combined = "false"; virtual = "true" },
  @{ name = "merged+virtual"; combined = "true"; virtual = "true" }
)
foreach ($c in $configs) {
  $env:COMBINED_RATE_LIMIT = $c.combined
  $env:VIRTUAL_THREADS = $c.virtual
  Write-Host "== $($c.name)"
  Compose up -d --scale app=1 2>&1 | Out-Null
  Wait-App
  Start-Sleep 5
  $tag = $c.name -replace '[+]', '_'
  $script:offset += 10000000
  Write-Host "   warm-up 45 s"
  Load "hot_${tag}_warm" 45 | Out-Null
  Start-Sleep 3
  $script:offset += 10000000
  $before = EvalshaCalls
  $name = "hot_$tag"
  $samples = Load $name $Seconds
  Start-Sleep 2
  $after = EvalshaCalls
  $j = Get-Content "results\$name.json" -Raw | ConvertFrom-Json
  Move-Item "results\$name.json" "$out\$name.json" -Force
  $app = $samples | Where-Object { $_.name -match "-app-\d+$" }
  $appCpu = if ($app) { [math]::Round(($app | Measure-Object cpu -Average).Average, 2) } else { 0 }
  $redis = $samples | Where-Object { $_.name -match "-redis-1$" }
  $redisCpu = if ($redis) { [math]::Round(($redis | Measure-Object cpu -Average).Average, 2) } else { 0 }
  $reqs = $j.metrics.http_reqs.values.count
  $rows += [pscustomobject]@{
    config = $c.name
    achieved = [math]::Round($j.metrics.http_reqs.values.rate, 0)
    reqs = $reqs
    med = [math]::Round($j.metrics.http_req_duration.values.med, 1)
    p95 = [math]::Round($j.metrics.http_req_duration.values."p(95)", 1)
    failed = [math]::Round($j.metrics.http_req_failed.values.rate * 100, 2)
    appCpu = $appCpu
    redisCpu = $redisCpu
    evalshaPerReq = if ($reqs -gt 0) { [math]::Round(($after - $before) / $reqs, 3) } else { 0 }
  }
  Write-Host ("   achieved {0:N0} rps, p95 {1} ms, app {2} cores, redis {3}, evalsha/req {4}" -f `
    $rows[-1].achieved, $rows[-1].p95, $appCpu, $redisCpu, $rows[-1].evalshaPerReq)
}

$env:COMBINED_RATE_LIMIT = "true"; $env:VIRTUAL_THREADS = "false"
$rows | Export-Csv "$out\hotpath.csv" -NoTypeInformation -Encoding UTF8
$md = @("# Hot-path A/B (1 replica, 2 vCPU, consumer stopped)", "",
  "- Closed loop, $VUs VUs for ${Seconds}s; the app is saturated, so achieved RPS = capacity.",
  "- Each config gets a 45 s warm-up first (JIT dominates otherwise: the same config moved 17% between runs).",
  "- merged = rate limit + claim in one Lua call; two-call = the original two round trips.",
  "- evalsha/req counts Redis script invocations per HTTP request (1 vs 2).", "",
  "| Config | Achieved RPS | vs baseline | Requests | Median ms | p95 ms | Failed | app cores | redis cores | evalsha / request |",
  "|---|---|---|---|---|---|---|---|---|---|")
$base = ($rows | Where-Object config -eq "two-call+platform").achieved
foreach ($r in $rows) {
  $md += "| $($r.config) | $($r.achieved) | $([math]::Round($r.achieved / $base, 2))x | $($r.reqs) | $($r.med) | $($r.p95) | $($r.failed)% | $($r.appCpu) | $($r.redisCpu) | $($r.evalshaPerReq) |"
}
$md | Set-Content "$out\hotpath.md" -Encoding UTF8
Write-Host "== wrote $out/hotpath.md"
