param([Parameter(Mandatory = $true)][string]$Executable)
$ErrorActionPreference = 'Stop'
$exe = [IO.Path]::GetFullPath($Executable)
if (!(Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Build the YYB service executable first.' }
if (Get-NetTCPConnection -LocalPort 18766 -State Listen -ErrorAction SilentlyContinue) {
    throw 'Port 18766 is already in use. Inspect the existing listener before starting another service.'
}
$private = Join-Path $PSScriptRoot '.local'
[IO.Directory]::CreateDirectory($private) | Out-Null
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $private /inheritance:r /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot restrict private runtime directory permissions.' }
$envFile = Join-Path $private 'yyb.env'
if (!(Test-Path -LiteralPath $envFile)) {
    $random = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($random)
    $token = [Convert]::ToBase64String($random).TrimEnd('=').Replace('+','-').Replace('/','_')
    $text = "YYB_AUTH_DRIVER=sqlite`nYYB_PROTOCOL_TOKEN=$token`nYYB_ENABLE_PC_LOGIN=false`nGIN_MODE=release`n"
    [IO.File]::WriteAllText($envFile, $text, [Text.UTF8Encoding]::new($false))
}
$resource = Join-Path $private 'resource'
$child = Start-Process -FilePath $exe -ArgumentList @('-host','127.0.0.1','-port','18766',
    '-resource-root', "`"$resource`"", '-env-file', "`"$envFile`"") -WorkingDirectory $private `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $private 'stdout.log') `
    -RedirectStandardError (Join-Path $private 'stderr.log')
[IO.File]::WriteAllText((Join-Path $private 'process.json'), (@{ pid = $child.Id; executable = $exe } | ConvertTo-Json))
for ($i = 0; $i -lt 30; $i++) {
    if ($child.HasExited) { throw 'YYB service exited. Inspect private stderr.log locally.' }
    try {
        $health = Invoke-RestMethod 'http://127.0.0.1:18766/health' -TimeoutSec 2
        if ($health.code -eq 0 -and $health.data.ok) { Write-Output "YYB_READY http://127.0.0.1:18766 PID=$($child.Id)"; exit 0 }
    } catch { }
    Start-Sleep -Milliseconds 200
}
throw 'YYB service readiness timed out; inspect the recorded process before retrying.'
