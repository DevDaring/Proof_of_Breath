# Optional. Dot-source this from your PowerShell profile to route these tools through `pob run`.
$script:PobCli = Join-Path $PSScriptRoot "..\cli\pob"

function Invoke-PobWrapped {
    param([string]$Tool, [object[]]$ToolArgs)
    $real = (Get-Command $Tool -CommandType Application | Select-Object -First 1).Source
    python $script:PobCli run -- $real @ToolArgs
}

function terraform { Invoke-PobWrapped "terraform" $args }
function kubectl { Invoke-PobWrapped "kubectl" $args }
function psql { Invoke-PobWrapped "psql" $args }
