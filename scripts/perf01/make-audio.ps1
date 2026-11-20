# PERF-01: synthesize the fixture questions as speech, locally.
#
# Windows' built-in speech synthesizer (System.Speech) writes each question
# to a WAV file in the format the Realtime transcriber takes: PCM16, 24 kHz,
# mono. Nothing goes over the network and no audio device is opened — the
# synthesizer writes straight to the file. The live driver
# (e2e/live-perf01.spec.ts) streams these files into a session through the
# app's own audio IPC, so the measured path includes real speech-to-text
# without a microphone or call capture.
#
# Usage (Windows PowerShell 5.1):
#   powershell -ExecutionPolicy Bypass -File scripts/perf01/make-audio.ps1 `
#     -Questions test-results/perf01/questions.json -OutDir test-results/perf01/audio
#
# questions.json: [{ "id": "G01", "text": "…" }, …] (written by the driver).
param(
  [Parameter(Mandatory = $true)][string]$Questions,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [int]$Rate = 0
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$items = Get-Content -Raw -Encoding UTF8 $Questions | ConvertFrom-Json
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = $Rate
$count = 0
foreach ($q in $items) {
  $path = Join-Path $OutDir ("{0}.wav" -f $q.id)
  $synth.SetOutputToWaveFile($path, $format)
  $synth.Speak([string]$q.text)
  $synth.SetOutputToNull()
  $count++
}
$synth.Dispose()
Write-Output ("perf01 audio: {0} files in {1}" -f $count, $OutDir)
