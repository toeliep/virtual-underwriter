$lines = Get-Content "rater-app\src\TelematixRater.jsx"

# Add processDocumentMulti function before the return statement (line 1792)
$multiFunc = @'
  const processDocumentMulti = useCallback(async (files) => {
    if (!files || files.length === 0) return;
    setUploadedFileNames(files.map(f => f.name));
    let merged = {};
    let mergedRegister = [];
    for (const file of files) {
      await processDocument(file, (extracted) => {
        // Merge: only overwrite if new value is non-null and current is null/missing
        for (const [k, v] of Object.entries(extracted)) {
          if (k === 'vehicle_register') continue;
          if (v !== null && v !== undefined && v !== '') {
            if (merged[k] === null || merged[k] === undefined || merged[k] === '') {
              merged[k] = v;
            }
          }
        }
        if (Array.isArray(extracted.vehicle_register) && extracted.vehicle_register.length > 0) {
          mergedRegister = extracted.vehicle_register;
        }
      });
    }
  }, [processDocument]);
'@

# Line 1786: replace single-file drop handler
$lines[1785] = '    const files = Array.from(e.dataTransfer.files || []);'
$lines[1786] = '    if (files.length > 0) processDocumentMulti(files);'

# Line 1790: replace single-file select handler  
$lines[1789] = '    const files = Array.from(e.target.files || []);'
$lines[1790] = '    if (files.length > 0) processDocumentMulti(files);'

# Insert processDocumentMulti before line 1792 (the return statement)
$before = $lines[0..1790]
$after = $lines[1791..($lines.Length-1)]
$newLines = $before + $multiFunc + $after

$newLines | Set-Content "rater-app\src\TelematixRater.jsx"
Write-Host "Done - $($newLines.Length) lines"