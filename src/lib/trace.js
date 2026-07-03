'use strict';
// trace 脊柱(§9.4):每行 {ts,session_id,turn,type,...},追加写,永不阻塞宿主(P6/§3.4)
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(os.homedir(), '.supathink');

function sessionDir(sessionId) {
  const dir = path.join(ROOT, 'sessions', String(sessionId || 'unknown'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionStateExists(sessionId) { // 零足迹探测:不建目录
  try {
    return fs.existsSync(path.join(ROOT, 'sessions', String(sessionId || 'unknown'), 'state.json'));
  } catch (_) { return false; }
}

function appendTrace(sessionId, event) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), session_id: sessionId, ...event });
    fs.appendFileSync(path.join(sessionDir(sessionId), 'trace.jsonl'), line + '\n');
  } catch (_) { /* trace 失败不得影响宿主 */ }
}

function loadState(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionDir(sessionId), 'state.json'), 'utf8'));
  } catch (_) {
    return { session_id: sessionId, turn: 0, last_mode: 'off', created_at: new Date().toISOString() };
  }
}

function saveState(sessionId, state) { // 返回是否落盘成功:循环上限等安全机制依赖此信号(评审 F4)
  try {
    state.updated_at = new Date().toISOString();
    fs.writeFileSync(path.join(sessionDir(sessionId), 'state.json'), JSON.stringify(state, null, 2));
    return true;
  } catch (_) { return false; }
}

module.exports = { ROOT, sessionDir, sessionStateExists, appendTrace, loadState, saveState };
