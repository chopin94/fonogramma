# Autorizza la chiave SSH di questo PC sul PC di casa (chiede la password dell'utente remoto).
# Riprova da solo se il server chiude la richiesta per tempo scaduto (circa 2 minuti).
# Uso: .utorizza-ssh.ps1 utente@host
param([Parameter(Mandatory = $true)][string]$Host_)
$key = (Get-Content -Raw "$env:USERPROFILE\.ssh\id_ed25519.pub").Trim()
$ssh = "$env:WINDIR\System32\OpenSSH\ssh.exe"
$remote = "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && (grep -qxF '$key' ~/.ssh/authorized_keys || echo '$key' >> ~/.ssh/authorized_keys) && echo CHIAVE-AUTORIZZATA"
for ($i = 1; $i -le 5; $i++) {
    Write-Host ""
    Write-Host "Tentativo $i di 5: scrivi la password di $Host_ e premi Invio (i caratteri non vengono mostrati)."
    & $ssh -o StrictHostKeyChecking=accept-new -o PreferredAuthentications=password,keyboard-interactive -o NumberOfPasswordPrompts=1 $Host_ $remote
    if ($LASTEXITCODE -eq 0) { Write-Host "Fatto: puoi chiudere questa scheda."; exit 0 }
    Write-Host "Accesso non riuscito o tempo scaduto, riprovo..."
}
Write-Host "Non sono riuscito ad autorizzare la chiave."
exit 1
