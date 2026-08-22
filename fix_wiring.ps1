$content = Get-Content "rater-app\src\TelematixRater.jsx" -Raw
$old = 'updated.iot_devices_fitted = extracted.iot_devices;`n        if (extracted.hcv_data_source) updated.hcv_data_source = extracted.hcv_data_source;'
$new = 'updated.iot_devices_fitted = extracted.iot_devices;' + "`r`n" + '        if (extracted.hcv_data_source) updated.hcv_data_source = extracted.hcv_data_source;'
$content.Replace($old, $new) | Set-Content "rater-app\src\TelematixRater.jsx"