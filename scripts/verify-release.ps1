param([switch]$KeepRunning)

$ErrorActionPreference = 'Stop'
$project = 'coupon-release-test-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$compose = @('compose', '-p', $project, '--env-file', 'deploy/rehearsal.env',
    '-f', 'docker-compose.release.yml', '-f', 'docker-compose.rehearsal.yml')

function Invoke-Compose {
    & docker @compose @args
    if ($LASTEXITCODE -ne 0) { throw "Docker Compose failed: $args" }
}

function Invoke-Sql([string]$Database, [string]$Sql) {
    Invoke-Compose exec -T postgres psql -XAt -v ON_ERROR_STOP=1 -U coupon -d $Database -c $Sql
}

function Wait-For([string]$Description, [scriptblock]$Check) {
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    do {
        try { if (& $Check) { return } } catch { Write-Verbose $_ }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Timed out waiting for $Description"
}

Push-Location (Join-Path $PSScriptRoot '..')
try {
    Invoke-Compose up -d --build
    Wait-For 'shop and Keycloak' {
        $shop = Invoke-WebRequest -UseBasicParsing 'http://localhost:5186/api/coupons' -TimeoutSec 3
        $realm = Invoke-RestMethod 'http://localhost:8186/realms/coupons/.well-known/openid-configuration' -TimeoutSec 3
        $shop.StatusCode -eq 200 -and $realm.issuer -eq 'http://localhost:8186/realms/coupons'
    }
    $seed = Get-Content -Raw 'deploy/rehearsal-seed.sql'
    Invoke-Sql coupon $seed

    Push-Location e2e
    try {
        pnpm exec playwright test shop.spec.ts --workers=1
        if ($LASTEXITCODE -ne 0) { throw 'Browser acceptance failed' }
    } finally { Pop-Location }

    $inventory = Invoke-Sql coupon @'
SELECT c.name || ':' || c.stock || ':' || count(cc.id)
FROM coupon c LEFT JOIN coupon_claim cc ON cc.coupon_id = c.id
WHERE c.name IN ('Release race offer', 'Release duplicate offer')
GROUP BY c.id ORDER BY c.name;
'@
    if (($inventory -join ',') -ne 'Release duplicate offer:1:1,Release race offer:0:1') {
        throw "Unexpected persisted inventory: $inventory"
    }
    Write-Host 'PASS: concurrent claim inventory and duplicate protection'

    Invoke-Sql postgres 'CREATE DATABASE coupon_legacy;'
    Invoke-Sql coupon_legacy @'
CREATE TABLE coupon (id bigserial PRIMARY KEY, name text NOT NULL,
    total_stock int NOT NULL, stock int NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
INSERT INTO coupon (name, total_stock, stock) VALUES ('Legacy offer', 5, 4);
'@
    Invoke-Compose run --rm --no-deps -e PGDATABASE=coupon_legacy migrate
    Invoke-Compose run --rm --no-deps -e PGDATABASE=coupon_legacy migrate
    $legacy = Invoke-Sql coupon_legacy "SELECT name || ':' || stock || ':' || status FROM coupon;
SELECT count(*) FROM coupon_schema_migration;"
    if (($legacy -join ',') -ne 'Legacy offer:4:DRAFT,7') { throw "Unexpected migration result: $legacy" }
    Write-Host 'PASS: legacy data survives migration and repeated migration is a no-op'

    Invoke-Compose exec -T postgres sh -ec 'pg_dump -Fc -U coupon -d coupon -f /tmp/coupon.dump'
    Invoke-Sql postgres 'CREATE DATABASE coupon_restore;'
    Invoke-Compose exec -T postgres pg_restore --exit-on-error -U coupon -d coupon_restore /tmp/coupon.dump
    $snapshot = @'
SELECT md5(string_agg(row_to_json(c)::text, '' ORDER BY c.id)) FROM coupon c;
SELECT md5(string_agg(row_to_json(c)::text, '' ORDER BY c.id)) FROM coupon_claim c;
SELECT md5(string_agg(row_to_json(o)::text, '' ORDER BY o.user_id, o.order_id)) FROM checkout_order o;
'@
    $original = Invoke-Sql coupon $snapshot
    $restored = Invoke-Sql coupon_restore $snapshot
    if (@($original).Count -ne 3 -or @($original | Where-Object { $_ -match '^[a-f0-9]{32}$' }).Count -ne 3 -or
            ($original -join ',') -ne ($restored -join ',')) { throw 'Restored business data differs' }
    Write-Host 'PASS: backup restores coupon, claim and order data'

    Wait-For 'healthy metrics' {
        $metrics = Invoke-RestMethod 'http://localhost:9196/api/v1/targets' -TimeoutSec 3
        @($metrics.data.activeTargets | Where-Object health -eq 'up').Count -eq 1
    }
    Invoke-Compose stop app
    Wait-For 'outage alert' {
        $alerts = Invoke-RestMethod 'http://localhost:9196/api/v1/alerts' -TimeoutSec 3
        @($alerts.data.alerts | Where-Object { $_.labels.alertname -eq 'CouponScrapeUnavailable' -and
            $_.state -eq 'firing' }).Count -eq 1
    }
    Invoke-Compose start app
    Wait-For 'shop recovery and cleared alert' {
        $shop = Invoke-WebRequest -UseBasicParsing 'http://localhost:5186/api/coupons' -TimeoutSec 3
        $alerts = Invoke-RestMethod 'http://localhost:9196/api/v1/alerts' -TimeoutSec 3
        $shop.StatusCode -eq 200 -and
            @($alerts.data.alerts | Where-Object { $_.labels.alertname -eq 'CouponScrapeUnavailable' }).Count -eq 0
    }
    Write-Host 'PASS: outage alert fires and clears when the app recovers'
    Write-Host 'RELEASE ACCEPTANCE PASSED'
} catch {
    & docker @compose logs --no-color --tail 50
    throw
} finally {
    if ($KeepRunning) {
        Write-Host "Rehearsal project: $project"
    } else {
        & docker @compose down --volumes
    }
    Pop-Location
}
