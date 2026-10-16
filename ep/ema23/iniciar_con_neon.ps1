$ErrorActionPreference = "Stop"
$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectDirectory

$secureConnectionString = Read-Host "Pega la cadena DATABASE_URL de Neon (no se mostrara)" -AsSecureString
$connectionPointer = [IntPtr]::Zero

try {
    $connectionPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureConnectionString)
    $env:DATABASE_URL = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($connectionPointer)

    python -m pip install -r requirements.txt
    if ($LASTEXITCODE -ne 0) {
        throw "No se pudieron instalar las dependencias de AJSE."
    }

    Write-Host ""
    Write-Host "Abre http://127.0.0.1:5000 en el navegador."
    Write-Host "La cadena de conexión solo estará disponible mientras este servidor esté ejecutándose."
    python app.py
    if ($LASTEXITCODE -ne 0) {
        throw "El servidor AJSE terminó con un error."
    }
}
finally {
    Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
    if ($connectionPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($connectionPointer)
    }
    $secureConnectionString.Dispose()
}
