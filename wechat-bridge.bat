@echo off
cd /d C:\Users\GAME\Desktop\work
pwsh -NoLogo -Command "npx -y wechat-acp@latest --agent 'node wechat-adapter.js' --cwd 'C:\Users\GAME\Desktop\work' --daemon"
exit /b 0
