; Custom steps of the Windows installer (electron-builder includes build/installer.nsh).
;
; Scamcrobat appears in "Open with" for images (it makes a PDF of them), but never
; becomes their default app: only an OpenWithProgids entry is added for each type.
; The list matches IMAGE_EXTENSIONS in electron/main.js.

!macro scamcrobatImageType EXT
  WriteRegStr SHELL_CONTEXT "Software\Classes\${EXT}\OpenWithProgids" "Scamcrobat.Image" ""
!macroend

!macro scamcrobatRemoveImageType EXT
  DeleteRegValue SHELL_CONTEXT "Software\Classes\${EXT}\OpenWithProgids" "Scamcrobat.Image"
!macroend

!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\Scamcrobat.Image" "" "Image"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Scamcrobat.Image\DefaultIcon" "" "$appExe,0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Scamcrobat.Image\shell\open" "FriendlyAppName" "Scamcrobat"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Scamcrobat.Image\shell\open\command" "" '"$appExe" "%1"'
  !insertmacro scamcrobatImageType ".jpg"
  !insertmacro scamcrobatImageType ".jpeg"
  !insertmacro scamcrobatImageType ".jpe"
  !insertmacro scamcrobatImageType ".jfif"
  !insertmacro scamcrobatImageType ".png"
  !insertmacro scamcrobatImageType ".gif"
  !insertmacro scamcrobatImageType ".bmp"
  !insertmacro scamcrobatImageType ".tif"
  !insertmacro scamcrobatImageType ".tiff"
  !insertmacro scamcrobatImageType ".webp"
  System::Call 'shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  !insertmacro scamcrobatRemoveImageType ".jpg"
  !insertmacro scamcrobatRemoveImageType ".jpeg"
  !insertmacro scamcrobatRemoveImageType ".jpe"
  !insertmacro scamcrobatRemoveImageType ".jfif"
  !insertmacro scamcrobatRemoveImageType ".png"
  !insertmacro scamcrobatRemoveImageType ".gif"
  !insertmacro scamcrobatRemoveImageType ".bmp"
  !insertmacro scamcrobatRemoveImageType ".tif"
  !insertmacro scamcrobatRemoveImageType ".tiff"
  !insertmacro scamcrobatRemoveImageType ".webp"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Scamcrobat.Image"
!macroend
