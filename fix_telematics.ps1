$content = Get-Content "rater-app\src\TelematixRater.jsx" -Raw
$old = 'VEHICLE REGISTER RULES:'
$new = 'AFRIKAANS COLUMN HEADER MAPPINGS (common in SA fleet schedules):
- JAAR = year model
- MAAK = make / manufacturer
- MODEL = model description
- REG NO or REGISTRASIE = registration number
- AGREED VALUE or WAARDE = insured / agreed value
- VIN NO = chassis number (ignore for register)
- VRAGMOTORS or TREKKERS = HCV truck section (asset_type: hcv)
- TRAILERS or SLEEPERS = trailer section (asset_type: trailer)
- ITEM = row number (ignore)
When a spreadsheet has separate sections for trucks and trailers (e.g. VRAGMOTORS / TRAILERS), extract ALL vehicles from ALL sections into vehicle_register. Use the section header to set asset_type.

VEHICLE REGISTER RULES:'
$content.Replace($old, $new) | Set-Content "rater-app\src\TelematixRater.jsx"
Write-Host "Done"