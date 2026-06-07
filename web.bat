@echo off
pwsh -NoLogo -Command "$env:OPENCODE_SERVER_PASSWORD='opencode'; opencode web --hostname 0.0.0.0 --port 4096"
