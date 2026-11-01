@echo off
rem ==================================================================
rem  Your private Kite settings, read by start_home.bat.
rem  Copy this file to kite-secrets.bat (git ignores that one, so
rem  passwords and secrets in it never go to GitHub):
rem      copy kite-secrets.example.bat kite-secrets.bat
rem  Remove "rem " from the start of a line to turn that setting on.
rem ==================================================================

rem Log every YouTube video chunk in the "Kite backend" window
rem ([video] lines), to see when and why videos stop.
set KITE_MEDIA_LOG=1

rem For finding a crash: switch parts of Kite's in-page script off (comma-separated):
rem   native, parent, frames, address, function, dom, elements, navigation,
rem   history, cookies, reflect, diagnostics
rem set KITE_CLIENT_OFF=frames,parent
rem And Kite's rewriting of sites' scripts (0 = off):
rem set KITE_JS_REWRITE=0

rem Who may open Kite DevTools (kite://devtools in Kite Web): Kite account
rem usernames or Google emails, comma-separated. It shows everyone's browsing
rem through your backend, so list only yourself.
rem set KITE_DEVTOOLS_USERS=yourname

rem Sign in with Google (see README.md, "Kite accounts and Sign in with Google").
rem set GOOGLE_CLIENT_ID=1234-abcd.apps.googleusercontent.com
rem set GOOGLE_CLIENT_SECRET=GOCSPX-...
rem set KITE_GOOGLE_ALLOWED=you@gmail.com

rem Stop new Kite accounts from being created (0 = off).
rem set KITE_SIGNUP=0
