$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

try {
    Write-Host "Starting local PostgreSQL..." -ForegroundColor Cyan
    docker compose up -d --wait postgres

    # A standalone Redis (for example the `pharmica-redis` container) may already own port 6379.
    $redisListening = Get-NetTCPConnection -LocalPort 6379 -State Listen -ErrorAction SilentlyContinue
    if ($redisListening) {
        Write-Host "Redis is already listening on 6379; skipping the Compose Redis service." -ForegroundColor Yellow
    } else {
        Write-Host "Starting local Redis..." -ForegroundColor Cyan
        docker compose up -d --wait redis
    }

    Write-Host "Applying database migrations..." -ForegroundColor Cyan
    pnpm.cmd --filter @pharmica/database db:migrate:deploy

    Write-Host "Seeding development data..." -ForegroundColor Cyan
    pnpm.cmd --filter @pharmica/database db:seed

    Write-Host "Development services and database are ready." -ForegroundColor Green
}
finally {
    Pop-Location
}
