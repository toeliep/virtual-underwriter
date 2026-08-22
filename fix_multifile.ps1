$content = Get-Content "rater-app\src\TelematixRater.jsx" -Raw

# Fix 1: handleDrop to process all files
$content = $content.Replace(
    'if (file) processDocument(file);
  }, [processDocument]);
  const handleFileSelect = useCallback((e) => {
    const file = e.target.files[0];
    if (file) processDocument(file);
  }, [processDocument]);',
    'if (file) processDocumentMulti([file]);
  }, [processDocument]);
  const handleFileSelect = useCallback((e) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) processDocumentMulti(files);
  }, [processDocument]);'
)

# Fix 2: Add multiple attribute to file input
$content = $content.Replace(
    'accept=".pdf,.xlsx,.xls,.csv"
            onChange={handleFileSelect}',
    'accept=".pdf,.xlsx,.xls,.csv"
            multiple
            onChange={handleFileSelect}'
)

$content | Set-Content "rater-app\src\TelematixRater.jsx"
Write-Host "Done"