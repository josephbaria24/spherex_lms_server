# Generate IELTS Listening practice WAV files (Windows SAPI TTS).
# Run: powershell -ExecutionPolicy Bypass -File scripts/generate-ielts-audio.ps1

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech

$outDir = Join-Path $PSScriptRoot "..\..\lms-client\public\media\ielts"
# Resolve from lms-server/scripts if present; else from repo-relative path passed by caller
if (-not (Test-Path (Split-Path $outDir -Parent))) {
  $outDir = "c:\Users\delar\Downloads\PETROSPHERE_PROJECT\SphereX-LMS\lms-client\public\media\ielts"
}
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function New-DialogueWav {
  param(
    [string]$FileName,
    [scriptblock]$Build
  )
  $path = Join-Path $outDir $FileName
  $syn = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $syn.Rate = -2
  $syn.Volume = 100
  $syn.SetOutputToWaveFile($path)
  $b = New-Object System.Speech.Synthesis.PromptBuilder
  & $Build $b
  $syn.Speak($b)
  $syn.Dispose()
  $len = (Get-Item $path).Length
  Write-Host "  + $FileName ($([math]::Round($len/1KB)) KB)"
}

Write-Host "Generating IELTS listening audio → $outDir"

# 1) Hotel booking (existing form completion)
New-DialogueWav "hotel-booking.wav" {
  param($b)
  $b.StartVoice("Microsoft Hazel Desktop")
  $b.AppendText("You will hear a telephone conversation between a hotel receptionist and a guest.")
  $b.AppendBreak([TimeSpan]::FromSeconds(1))
  $b.AppendText("Good morning, Riverside Hotel. How may I help you?")
  $b.EndVoice()
  $b.AppendBreak([TimeSpan]::FromMilliseconds(350))
  $b.StartVoice("Microsoft Zira Desktop")
  $b.AppendText("Hello. I'd like to book a double room, please.")
  $b.EndVoice()
  $b.AppendBreak([TimeSpan]::FromMilliseconds(300))
  $b.StartVoice("Microsoft Hazel Desktop")
  $b.AppendText("Of course. For which dates?")
  $b.EndVoice()
  $b.AppendBreak([TimeSpan]::FromMilliseconds(300))
  $b.StartVoice("Microsoft Zira Desktop")
  $b.AppendText("I'd like to check in on the fifteenth of March, for three nights.")
  $b.EndVoice()
  $b.AppendBreak([TimeSpan]::FromMilliseconds(300))
  $b.StartVoice("Microsoft Hazel Desktop")
  $b.AppendText("So that's three nights, checking out on the eighteenth. And the name for the booking?")
  $b.EndVoice()
  $b.AppendBreak([TimeSpan]::FromMilliseconds(300))
  $b.StartVoice("Microsoft Zira Desktop")
  $b.AppendText("Thompson. That's T. H. O. M. P. S. O. N.")
  $b.EndVoice()
  $b.AppendBreak([TimeSpan]::FromMilliseconds(300))
  $b.StartVoice("Microsoft Hazel Desktop")
  $b.AppendText("Thank you, Miss Thompson. Our hotel offers free Wi-Fi, an indoor pool, and an airport shuttle. We don't have a helipad, I'm afraid.")
  $b.EndVoice()
  $b.AppendBreak([TimeSpan]::FromMilliseconds(300))
  $b.StartVoice("Microsoft Zira Desktop")
  $b.AppendText("That's fine. What time is breakfast?")
  $b.EndVoice()
  $b.AppendBreak([TimeSpan]::FromMilliseconds(300))
  $b.StartVoice("Microsoft Hazel Desktop")
  $b.AppendText("Breakfast is served until ten o'clock in the morning. That's ten A. M.")
  $b.EndVoice()
  $b.AppendBreak([TimeSpan]::FromMilliseconds(300))
  $b.StartVoice("Microsoft Zira Desktop")
  $b.AppendText("Perfect. Could I have the confirmation number?")
  $b.EndVoice()
  $b.AppendBreak([TimeSpan]::FromMilliseconds(300))
  $b.StartVoice("Microsoft Hazel Desktop")
  $b.AppendText("Yes. Your booking confirmation number is H. T. four eight two one.")
  $b.AppendBreak([TimeSpan]::FromMilliseconds(500))
  $b.AppendText("You're welcome. We look forward to seeing you.")
  $b.EndVoice()
}

# 2) Campus tour
New-DialogueWav "campus-tour.wav" {
  param($b)
  $b.StartVoice("Microsoft Hazel Desktop")
  $b.AppendText("You will hear a campus tour guide speaking to new students.")
  $b.AppendBreak([TimeSpan]::FromSeconds(1))
  $b.AppendText("Welcome to Westbridge University. I'm Claire, and I'll be showing you around today.")
  $b.AppendBreak([TimeSpan]::FromMilliseconds(500))
  $b.AppendText("Our main library is open until ten p.m. on weekdays, and until six p.m. on Saturdays. It is closed on Sundays.")
  $b.AppendBreak([TimeSpan]::FromMilliseconds(500))
  $b.AppendText("Student ID cards are issued at the reception desk in the Student Union building, which is next to the sports centre.")
  $b.AppendBreak([TimeSpan]::FromMilliseconds(500))
  $b.AppendText("The campus café serves hot meals from eleven thirty until two thirty, and snacks all afternoon.")
  $b.AppendBreak([TimeSpan]::FromMilliseconds(500))
  $b.AppendText("If you need help with course registration, go to the Academic Advice office on the second floor of the Admin Block.")
  $b.AppendBreak([TimeSpan]::FromMilliseconds(500))
  $b.AppendText("Finally, free campus shuttle buses leave every twenty minutes from the main gate.")
  $b.EndVoice()
}

# 3) Museum exhibit
New-DialogueWav "museum-exhibit.wav" {
  param($b)
  $b.StartVoice("Microsoft Zira Desktop")
  $b.AppendText("You will hear a museum educator speaking to visitors.")
  $b.AppendBreak([TimeSpan]::FromSeconds(1))
  $b.AppendText("Good afternoon everyone. Before you explore the permanent galleries, I'd like to recommend our temporary exhibition upstairs.")
  $b.AppendBreak([TimeSpan]::FromMilliseconds(450))
  $b.AppendText("It's called Rivers of Glass, and it runs until the end of July.")
  $b.AppendBreak([TimeSpan]::FromMilliseconds(450))
  $b.AppendText("The exhibition focuses on contemporary glass artists from Northern Europe.")
  $b.AppendBreak([TimeSpan]::FromMilliseconds(450))
  $b.AppendText("Adult tickets for the temporary show are eight pounds, but students pay only five pounds with a valid card.")
  $b.AppendBreak([TimeSpan]::FromMilliseconds(450))
  $b.AppendText("Photography without flash is allowed, and a free audio guide is available at the information desk.")
  $b.AppendBreak([TimeSpan]::FromMilliseconds(450))
  $b.AppendText("Please note the café closes at four today because of a private event this evening.")
  $b.EndVoice()
}

# 4) Student group project
New-DialogueWav "group-project.wav" {
  param($b)
  $b.StartVoice("Microsoft Hazel Desktop")
  $b.AppendText("You will hear two students discussing a group project.")
  $b.AppendBreak([TimeSpan]::FromSeconds(1))
  $b.AppendText("Have you started the media studies assignment yet?")
  $b.EndVoice()
  $b.AppendBreak([TimeSpan]::FromMilliseconds(300))
  $b.StartVoice("Microsoft Zira Desktop")
  $b.AppendText("Not really. I think the topic is too broad. Should we ask the tutor for an extension?")
  $b.EndVoice()
  $b.AppendBreak([TimeSpan]::FromMilliseconds(300))
  $b.StartVoice("Microsoft Hazel Desktop")
  $b.AppendText("I'd rather not. Why don't we keep the topic, but split the research? You take social media trends, and I'll cover traditional newspapers.")
  $b.EndVoice()
  $b.AppendBreak([TimeSpan]::FromMilliseconds(300))
  $b.StartVoice("Microsoft Zira Desktop")
  $b.AppendText("That works. Can we meet on Friday afternoon to compare notes?")
  $b.EndVoice()
  $b.AppendBreak([TimeSpan]::FromMilliseconds(300))
  $b.StartVoice("Microsoft Hazel Desktop")
  $b.AppendText("Friday is perfect. Let's meet in the library at three o'clock, and we'll finish the outline before the weekend.")
  $b.EndVoice()
  $b.AppendBreak([TimeSpan]::FromMilliseconds(300))
  $b.StartVoice("Microsoft Zira Desktop")
  $b.AppendText("Great. I'll bring the survey results as well.")
  $b.EndVoice()
}

# 5) Weather forecast
New-DialogueWav "weather-forecast.wav" {
  param($b)
  $b.StartVoice("Microsoft Hazel Desktop")
  $b.AppendText("You will hear a short weather forecast.")
  $b.AppendBreak([TimeSpan]::FromSeconds(1))
  $b.AppendText("Good evening. Here's the outlook for the weekend across the region.")
  $b.AppendBreak([TimeSpan]::FromMilliseconds(450))
  $b.AppendText("Saturday will be mostly cloudy with light showers in the afternoon. Temperatures will reach about sixteen degrees.")
  $b.AppendBreak([TimeSpan]::FromMilliseconds(450))
  $b.AppendText("Sunday looks more unsettled. We expect strong winds and rain for most of the day, especially near the coast.")
  $b.AppendBreak([TimeSpan]::FromMilliseconds(450))
  $b.AppendText("By Monday morning, conditions should improve, with clearer skies and lighter breezes.")
  $b.AppendBreak([TimeSpan]::FromMilliseconds(450))
  $b.AppendText("If you're travelling on Sunday, allow extra time, as some coastal roads may flood.")
  $b.EndVoice()
}

# 6) Job interview
New-DialogueWav "job-interview.wav" {
  param($b)
  $b.StartVoice("Microsoft Hazel Desktop")
  $b.AppendText("You will hear part of a job interview.")
  $b.AppendBreak([TimeSpan]::FromSeconds(1))
  $b.AppendText("Thank you for coming in today. Could you tell me which skill you consider your strongest?")
  $b.EndVoice()
  $b.AppendBreak([TimeSpan]::FromMilliseconds(350))
  $b.StartVoice("Microsoft Zira Desktop")
  $b.AppendText("I'd say data analysis is my strongest skill. In my last role I built monthly dashboards and reduced reporting time by half.")
  $b.EndVoice()
  $b.AppendBreak([TimeSpan]::FromMilliseconds(350))
  $b.StartVoice("Microsoft Hazel Desktop")
  $b.AppendText("And how comfortable are you with public speaking?")
  $b.EndVoice()
  $b.AppendBreak([TimeSpan]::FromMilliseconds(350))
  $b.StartVoice("Microsoft Zira Desktop")
  $b.AppendText("I can present to small teams, but I'm less confident with large audiences. I'm taking a short course to improve that.")
  $b.EndVoice()
  $b.AppendBreak([TimeSpan]::FromMilliseconds(350))
  $b.StartVoice("Microsoft Hazel Desktop")
  $b.AppendText("The role starts on the first of September. Would that work for you?")
  $b.EndVoice()
  $b.AppendBreak([TimeSpan]::FromMilliseconds(350))
  $b.StartVoice("Microsoft Zira Desktop")
  $b.AppendText("Yes, that date is fine. I can also complete the online onboarding in August if needed.")
  $b.EndVoice()
}

# 7) Fitness radio ad
New-DialogueWav "fitness-ad.wav" {
  param($b)
  $b.StartVoice("Microsoft Zira Desktop")
  $b.AppendText("You will hear a radio advertisement.")
  $b.AppendBreak([TimeSpan]::FromSeconds(1))
  $b.AppendText("Looking for a fresh start this week? Join Pulse Fitness for our beginner-friendly evening classes.")
  $b.AppendBreak([TimeSpan]::FromMilliseconds(450))
  $b.AppendText("Try any class free before this Friday. After that, membership starts at twenty nine pounds a month.")
  $b.AppendBreak([TimeSpan]::FromMilliseconds(450))
  $b.AppendText("We are open from six a.m. until ten p.m., seven days a week, with lockers and showers included.")
  $b.AppendBreak([TimeSpan]::FromMilliseconds(450))
  $b.AppendText("Visit us on High Street, or book online at pulse fitness dot com.")
  $b.EndVoice()
}

Write-Host "Done."
