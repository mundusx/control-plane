param([string]$Username = 'admin1')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
Push-Location $taskRoot
try {
    # Build before requesting the password. No secret is passed on a command line.
    cargo build --quiet -p opengpu-control-plane --example admin-password-hash
    if ($LASTEXITCODE -ne 0) { throw 'Could not build the password hasher.' }
    $taskPassword = Read-Host "Choose password for $Username (at least 12 characters)" -AsSecureString
    $taskCredential = [System.Net.NetworkCredential]::new('', $taskPassword)
    $taskHash = $taskCredential.Password | cargo run --quiet -p opengpu-control-plane --example admin-password-hash
    if ($LASTEXITCODE -ne 0 -or $taskHash -notmatch '^\$argon2id\$') { throw 'Could not hash the password.' }
    $taskProject = '78764161-9dd8-42f4-98f4-92cf5a4a06db'
    $taskService = 'ee4e8ede-1af5-4b1d-9b26-266f79f306c5'
    railway variable set --project $taskProject --environment prod --service $taskService --skip-deploys "MUNDUSX_ADMIN_USERNAME=$Username" 'MUNDUSX_ADMIN_LOGIN_ENABLED=true'
    if ($LASTEXITCODE -ne 0) { throw 'Could not configure the admin username.' }
    $taskHash | railway variable set --project $taskProject --environment prod --service $taskService --skip-deploys --stdin MUNDUSX_ADMIN_PASSWORD_HASH
    if ($LASTEXITCODE -ne 0) { throw 'Could not configure the password hash.' }
    Write-Host 'Administrator password configured. No deployment was triggered; Google settings were preserved.'
} finally {
    Remove-Variable taskPassword, taskCredential, taskHash -ErrorAction SilentlyContinue
    Pop-Location
}
