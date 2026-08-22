$content = Get-Content "src\TelematixRater.jsx" -Raw

$old = '    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length > 0) processDocumentMulti(files);
  const handleFileSelect = useCallback((e) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) processDocumentMulti(files);
  const processDocumentMulti = useCallback(async (files) => {'

$new = '    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length > 0) processDocumentMulti(files);
  }, [processDocument]);
  const handleFileSelect = useCallback((e) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) processDocumentMulti(files);
  }, [processDocument]);
  const processDocumentMulti = useCallback(async (files) => {'

$content = $content.Replace($old, $new)
$content | Set-Content "src\TelematixRater.jsx"
Write-Host "Done"