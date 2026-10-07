param([Parameter(Mandatory=$true)][string]$QaRun, [Parameter(Mandatory=$true)][string]$PayloadId)
$ErrorActionPreference = 'Stop'
$testReportRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../reports/portable'))
$testRunRoot = [IO.Path]::GetFullPath($QaRun)
if (-not $testRunRoot.StartsWith($testReportRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'QA cleanup path outside reports/portable.' }
if ($PayloadId -notmatch '^[a-f0-9]{20}$') { throw 'Invalid payload id.' }
$testRuntimes = @(
    [IO.Path]::GetFullPath((Join-Path $testRunRoot "独立用户数据/LqqPortable/$PayloadId/runtime/node.exe")),
    [IO.Path]::GetFullPath((Join-Path $testRunRoot "迁移对局的用户数据/LqqPortable/$PayloadId/runtime/node.exe"))
)
foreach ($testProcess in (Get-CimInstance Win32_Process -Filter "Name = 'node.exe'")) {
    if ($testRuntimes -contains $testProcess.ExecutablePath) { Stop-Process -Id $testProcess.ProcessId -Force -ErrorAction SilentlyContinue }
}
