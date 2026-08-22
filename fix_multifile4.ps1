$lines = Get-Content "rater-app\src\TelematixRater.jsx"

# Add uploadedFileNames state after dragOver state (line 1488, index 1487)
$lines[1487] = $lines[1487] + "`r`n  const [uploadedFileNames, setUploadedFileNames] = useState([]);"

$lines | Set-Content "rater-app\src\TelematixRater.jsx"
Write-Host "Done"