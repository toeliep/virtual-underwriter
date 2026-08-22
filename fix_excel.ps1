$content = Get-Content "rater-app\src\TelematixRater.jsx" -Raw
$old = "        workbook.SheetNames.forEach((sheetName) => {`r`n          const sheet = workbook.Sheets[sheetName];`r`n          const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: `"`" });`r`n          if (rows.length < 2) return;"
$new = @'
        const jsVehicleRegister = [];
        workbook.SheetNames.forEach((sheetName) => {
          const sheet = workbook.Sheets[sheetName];
          const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
          if (rows.length < 2) return;
          let currentAssetType = "hcv";
          rows.forEach((row) => {
            const first = String(row[0] || "").toUpperCase().trim();
            if (first.includes("VRAGMOTOR") || first.includes("TREKKER")) { currentAssetType = "hcv"; return; }
            if (first.includes("TRAILER") || first.includes("SLEEPER")) { currentAssetType = "trailer"; return; }
            const allCols = row.map(c => String(c || "").toUpperCase());
            const isHeader = allCols.some(c => c === "JAAR" || c === "MAAK" || c === "REG NO" || c === "ITEM");
            if (isHeader) return;
            const jaar = row[1]; const maak = String(row[2] || "").trim(); const model = String(row[3] || "").trim();
            const regIdx = row.findIndex(c => /^[A-Z]{2,3}\d{3,6}[A-Z]{0,3}$/.test(String(c || "").trim()));
            const reg = regIdx >= 0 ? String(row[regIdx] || "").trim() : "unknown";
            const lastVal = [...row].reverse().find(c => { const n = parseFloat(String(c || "").replace(/[^0-9.]/g, "")); return !isNaN(n) && n > 10000; });
            const waarde = lastVal ? parseFloat(String(lastVal).replace(/[^0-9.]/g, "")) : 0;
            if (maak && maak !== "MAAK" && maak !== "" && !isNaN(waarde) && waarde > 0) {
              jsVehicleRegister.push({ registration: reg, make: maak, model: model, year: Number(jaar) || 0, insured_value: waarde, cover: "comp", asset_type: currentAssetType });
            }
          });
'@
$content.Replace($old, $new) | Set-Content "rater-app\src\TelematixRater.jsx"
Write-Host "Done: $($content.Contains($old.Substring(0,50)))"