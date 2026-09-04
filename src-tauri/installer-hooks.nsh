; Aurora — NSIS installer hooks.
;
; Puts `aurora` and `agw` on PATH as part of installing Aurora, so a fresh
; install can drive the agent from a terminal without first finding a button in
; Settings. An installer is the one moment a user expects their PATH to change,
; which is why this happens here and not on first launch.
;
; It calls Aurora's own `--install-cli` rather than editing PATH in NSIS. That
; code already handles the parts that are easy to get wrong — reading the
; existing PATH without truncating it, not adding a duplicate entry, clearing
; stale `aurora.exe` copies from older installs — and duplicating it here would
; leave two implementations to keep in step.
;
; Failure is ignored on purpose. A PATH entry is a convenience; a Windows
; install that rolls back because it could not add one would be a far worse
; outcome than a user clicking Install in Settings afterwards.

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Adding the aurora command to PATH..."
  nsExec::ExecToLog '"$INSTDIR\aurora.exe" --install-cli'
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Before the files go, while aurora.exe is still there to run.
  DetailPrint "Removing the aurora command from PATH..."
  nsExec::ExecToLog '"$INSTDIR\aurora.exe" --uninstall-cli'
  Pop $0
!macroend
