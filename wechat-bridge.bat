@echo off
cd /d %~dp0
pwsh -NoLogo -Command "npx -y wechat-acp@latest --agent 'node wechat-adapter.js' --cwd '%~dp0.' --daemon"
exit /b 0
