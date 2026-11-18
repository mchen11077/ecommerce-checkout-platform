@echo off
cd /d "%~dp0..\.."
set LOG=env_check.txt
echo ==== env check %date% %time% > %LOG%
echo [java] >> %LOG% & java -version >> %LOG% 2>&1
echo [mvn] >> %LOG% & call mvn -v >> %LOG% 2>&1
echo [docker] >> %LOG% & docker version >> %LOG% 2>&1
echo [compose] >> %LOG% & docker compose version >> %LOG% 2>&1
echo [jmeter] >> %LOG% & where jmeter >> %LOG% 2>&1
echo [cpu/mem] >> %LOG% & wmic cpu get Name,NumberOfCores,NumberOfLogicalProcessors >> %LOG% 2>&1
wmic ComputerSystem get TotalPhysicalMemory >> %LOG% 2>&1
echo Done. Results in %CD%\%LOG%
pause
