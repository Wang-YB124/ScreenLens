$root = Split-Path -Parent $PSScriptRoot
$paths = @(
    (Join-Path $root 'dist\ScreenLens'),
    (Join-Path $root 'dist\ScreenLens-1.1.0-win64')
)
foreach ($p in $paths) {
    if (Test-Path $p) {
        try {
            Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop
            Write-Output "removed $p"
        } catch {
            try {
                Rename-Item -LiteralPath $p -NewName ((Split-Path $p -Leaf) + '-legacy') -ErrorAction Stop
                Write-Output "renamed $p"
            } catch {
                Write-Output "could not clean $p"
            }
        }
    }
}
