# CouchHub TV v0.1 — build the Windows x64 release.
# Run on Windows from the repo root, with Node 22, pnpm 10, a stable Rust
# toolchain and the Visual Studio C++ Build Tools installed:
#   powershell -ExecutionPolicy Bypass -File .\publish.ps1
# Output: src-tauri\target\release\bundle\ (NSIS .exe installer + MSI).
# No trimming / AOT concept applies here — this is a Tauri (Rust + web)
# app, not .NET. The target PC needs no Node, pnpm or Rust.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

foreach ($cmd in @('node', 'pnpm', 'cargo')) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        throw "Required tool not found on PATH: $cmd. See README.md prerequisites."
    }
}

Write-Host 'Installing dependencies (frozen lockfile)...' -ForegroundColor Cyan
pnpm install --frozen-lockfile

Write-Host 'Building CouchHub TV (Tauri, Windows x64)...' -ForegroundColor Cyan
pnpm tauri build

$bundleDir = Join-Path $root 'src-tauri\target\release\bundle'
if (-not (Test-Path $bundleDir)) {
    throw 'Build finished but the bundle folder was not found.'
}

Write-Host ''
Write-Host 'Done. Release artifacts:' -ForegroundColor Green
Get-ChildItem -Recurse $bundleDir -Include *.exe, *.msi -File |
    ForEach-Object { Write-Host "  $($_.FullName)" -ForegroundColor Green }
Write-Host 'Copy the NSIS installer (.exe) to the mini PC and run it. No install step beyond that.' -ForegroundColor Green
Write-Host 'First run: add the Xtream Codes playlist in Settings. No subscription is bundled.' -ForegroundColor Green
