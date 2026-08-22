$lines = Get-Content "rater-app\src\TelematixRater.jsx"

# Line 1865 (index 1864) — after the error div, add file list display
# Find the exact line with "Extraction complete" and add file list after the status div block
$insert = @'
          {uploadedFileNames.length > 0 && (
            <div style={{ marginTop: "8px", fontSize: "0.76rem", color: "#5C6570" }}>
              <strong style={{ color: "#14213D" }}>Files uploaded:</strong>{" "}
              {uploadedFileNames.map((n, i) => (
                <span key={i} style={{ marginRight: "8px", background: "#F0F2F6", padding: "2px 6px", borderRadius: "4px" }}>{n}</span>
              ))}
            </div>
          )}
'@

$before = $lines[0..1864]
$after = $lines[1865..($lines.Length-1)]
$newLines = $before + $insert + $after

$newLines | Set-Content "rater-app\src\TelematixRater.jsx"
Write-Host "Done - $($newLines.Length) lines"