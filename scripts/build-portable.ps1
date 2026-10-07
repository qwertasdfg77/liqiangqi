$ErrorActionPreference = 'Stop'
$portableRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../build'))
$portableStage = Join-Path $portableRoot 'payload'
$portableZip = Join-Path $portableRoot 'payload.zip'
$portableRelease = Join-Path $portableRoot 'release'
$portableExe = Join-Path $portableRelease '力墙棋.exe'
$portableCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $portableCompiler)) { throw 'Windows C# compiler unavailable.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Path $portableRelease -Force | Out-Null
if (Test-Path -LiteralPath $portableZip) { Remove-Item -LiteralPath $portableZip }
# Write canonical ZIP paths explicitly: older .NET Framework ZipFile APIs use
# backslashes, while the payload manifest and ZIP specification use slashes.
$portableZipStream = [IO.File]::Create($portableZip)
$portableArchive = New-Object IO.Compression.ZipArchive($portableZipStream, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($portableFile in (Get-ChildItem -LiteralPath $portableStage -Recurse -File | Sort-Object FullName)) {
        $portableRelative = $portableFile.FullName.Substring($portableStage.Length + 1).Replace([char]92, [char]47)
        $portableEntry = $portableArchive.CreateEntry($portableRelative, [IO.Compression.CompressionLevel]::Optimal)
        $portableInput = [IO.File]::OpenRead($portableFile.FullName)
        $portableOutput = $portableEntry.Open()
        try { $portableInput.CopyTo($portableOutput) }
        finally { $portableOutput.Dispose(); $portableInput.Dispose() }
    }
} finally { $portableArchive.Dispose(); $portableZipStream.Dispose() }

# Draw the existing board-style mark as a Windows application icon.
$portableBitmap = New-Object Drawing.Bitmap 256,256
$portableGraphics = [Drawing.Graphics]::FromImage($portableBitmap)
$portableGraphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
$portableGraphics.Clear([Drawing.Color]::FromArgb(24,57,61))
$portablePen = New-Object Drawing.Pen ([Drawing.Color]::FromArgb(242,228,197)),14
foreach ($position in @(88,168)) {
    $portableGraphics.DrawLine($portablePen,48,$position,208,$position)
    $portableGraphics.DrawLine($portablePen,$position,48,$position,208)
}
$portablePng = New-Object IO.MemoryStream
$portableBitmap.Save($portablePng,[Drawing.Imaging.ImageFormat]::Png)
$portableBytes = $portablePng.ToArray()
$portableIconPath = Join-Path $portableRoot 'game.ico'
$portableIconFile = [IO.File]::Create($portableIconPath)
$portableWriter = New-Object IO.BinaryWriter $portableIconFile
$portableWriter.Write([uint16]0); $portableWriter.Write([uint16]1); $portableWriter.Write([uint16]1)
$portableWriter.Write([byte]0); $portableWriter.Write([byte]0); $portableWriter.Write([byte]0); $portableWriter.Write([byte]0)
$portableWriter.Write([uint16]1); $portableWriter.Write([uint16]32)
$portableWriter.Write([uint32]$portableBytes.Length); $portableWriter.Write([uint32]22); $portableWriter.Write($portableBytes)
$portableWriter.Dispose(); $portablePng.Dispose(); $portablePen.Dispose(); $portableGraphics.Dispose(); $portableBitmap.Dispose()

& $portableCompiler /nologo /target:winexe /platform:x64 /optimize+ "/out:$portableExe" "/win32icon:$portableIconPath" "/resource:$portableZip,lqq.payload" "/resource:$(Join-Path $portableRoot 'manifest.txt'),lqq.manifest" /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll (Join-Path $PSScriptRoot '../launcher/PortableLauncher.cs') (Join-Path $portableRoot 'PackageInfo.cs')
if ($LASTEXITCODE -ne 0) { throw "Portable compiler failed: $LASTEXITCODE" }
Get-Item -LiteralPath $portableExe | Select-Object FullName,Length | ConvertTo-Json
