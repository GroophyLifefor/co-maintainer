@echo off
rem Windows shim for the fake gh (CORE-03). Node cannot resolve an
rem extensionless command to a .cmd through PATH, so the harness passes this
rem file's absolute path in CM_GH_BIN and enables the shell for it.
node "%~dp0gh.mjs" %*
