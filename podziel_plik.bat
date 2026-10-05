@echo off
chcp 65001 > nul
setlocal enabledelayedexpansion

if "%~1"=="" (
    echo Uzycie: przeciągnij plik na plik bat lub wpisz: dziel_plik.bat "C:\sciezka\do\filmu.mkv"
    pause
    exit /b
)

set "INPUT_FILE=%~1"
set "CHUNK_BYTES=996147200"

:: Katalog gdzie znajduje się skrypt BAT
set "BAT_DIR=%~dp0"
:: Usuwamy końcowy myslnik/slash jeśli występuje
if "%BAT_DIR:~-1%"=="\" set "BAT_DIR=%BAT_DIR:~0,-1%"

:: Katalog pliku źródłowego
for %%F in ("%INPUT_FILE%") do set "SOURCE_DIR=%%~dpF"
if "%SOURCE_DIR:~-1%"=="\" set "SOURCE_DIR=%SOURCE_DIR:~0,-1%"

echo ===================================================
echo Wybierz lokalizację docelową dla podzielonych części:
echo ===================================================
echo [1] Folder ze skryptem BAT: "%BAT_DIR%"
echo [2] Folder z plikiem źródłowym: "%SOURCE_DIR%"
echo.
set /p "CHOICE=Wybierz opcję (1 lub 2) [Domyślnie 1]: "

if "%CHOICE%"=="2" (
    set "TARGET_DIR=%SOURCE_DIR%"
) else (
    set "TARGET_DIR=%BAT_DIR%"
)

echo.
echo Rozpoczynam dzielenie pliku: "%INPUT_FILE%" na części po ~950 MB...
echo Zapis do katalogu: "%TARGET_DIR%"
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$file=$env:INPUT_FILE; $targetDir=$env:TARGET_DIR; $chunkSize=[long]$env:CHUNK_BYTES; $fileName=[System.IO.Path]::GetFileName($file); $stream=[System.IO.File]::OpenRead($file); $buffer=New-Object byte[] $chunkSize; $i=1; while(($bytesRead=$stream.Read($buffer,0,$chunkSize)) -gt 0){ $partPath=[System.IO.Path]::Combine($targetDir, ('{0}.part{1:D2}' -f $fileName, $i)); $out=[System.IO.File]::Create($partPath); $out.Write($buffer,0,$bytesRead); $out.Close(); Write-Host ('[OK] Utworzono: {0} ({1} MB)' -f [System.IO.Path]::GetFileName($partPath), [math]::Round($bytesRead/1MB,2)); $i++ }; $stream.Close()"

echo.
echo Gotowe! Wszystkie części zostały zapisane w: "%TARGET_DIR%"
pause