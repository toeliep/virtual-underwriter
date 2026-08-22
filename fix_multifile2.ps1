$content = Get-Content "rater-app\src\TelematixRater.jsx" -Raw

# Fix handleDrop
$content = $content -replace 'if \(file\) processDocument\(file\);(\r?\n)  \}, \[processDocument\]\);(\r?\n)  const handleFileSelect = useCallback\(\(e\) => \{(\r?\n)    const file = e\.target\.files\[0\];(\r?\n)    if \(file\) processDocument\(file\);(\r?\n)  \}, \[processDocument\]\);', 'if (file) processDocumentMulti([file]);
  }, [processDocument]);
  const handleFileSelect = useCallback((e) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) processDocumentMulti(files);
  }, [processDocument]);'

# Fix file input to accept multiple
$content = $content -replace 'accept="\.pdf,\.xlsx,\.xls,\.csv"', 'accept=".pdf,.xlsx,.xls,.csv"
            multiple'

$content | Set-Content "rater-app\src\TelematixRater.jsx"
Write-Host "Done"