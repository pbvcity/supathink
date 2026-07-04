#!/usr/bin/env node
'use strict';
// statusline 标记(§3.2 慢查呈现链路之一;接线为可选,见 USAGE.md):
// stdin 收 Claude Code statusline JSON(含 session_id),有慢查待复核则输出标记行
const fs = require('fs');
const path = require('path');
const os = require('os');
try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const sid = input.session_id || (input.session && input.session.id) || '';
  const f = path.join(os.homedir(), '.supathink', 'sessions', String(sid), 'status.txt');
  const model = (input.model && (input.model.display_name || input.model.id)) || '';
  const st = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '';
  process.stdout.write(st ? `${model} | ${st}` : model);
} catch (_) { /* statusline 失败静默 */ }
