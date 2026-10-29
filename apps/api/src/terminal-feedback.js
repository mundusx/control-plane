const text = message => typeof message?.content === 'string' ? message.content :
  (Array.isArray(message?.content) ? message.content.filter(p=>p.type==='text').map(p=>p.text||'').join('\n') : '');

// Specific to an active localhost stop request. Never infer a stop from old
// history, and never execute commands on the gateway.
function terminalFeedbackPolicy(body) {
  if (!Array.isArray(body.tools) || !body.tools.some(t=>t.function?.name==='run_in_terminal')) return body;
  const latest = body.messages?.findLast(m=>m.role==='user');
  let request = text(latest);
  if (request.includes('<userRequest>')) request = request.match(/<userRequest>([\s\S]*?)<\/userRequest>\s*$/)?.[1] || '';
  const match = request.trim().match(/^(?:please\s+)?(?:kill|stop|close|terminate)\s+(?:this\s+|the\s+)?(?:server\s+(?:at|on)\s+)?(?:https?:\/\/)?(?:localhost|127\.0\.0\.1):(\d{1,5})\/?[.!]?$/i);
  if (!match || Number(match[1])<1 || Number(match[1])>65535) return body;
  const port=Number(match[1]);
  return {...body,messages:[...body.messages,{role:'developer',content:
    `For this request, stop only the server listening on local port ${port}. First inspect the listener and owning PID using the client's OS-appropriate command. On Windows use Get-NetTCPConnection -LocalPort ${port} -State Listen. Stop only the verified listener PID, never all node.exe processes or npm.cmd. npm.cmd is a script, not a process image. After successful termination, verify the listener once; do not claim it is still running without a listening socket. A process-not-found error requires checking the port, not repeating the same kill. ESTABLISHED and TIME_WAIT connections do not establish a local listener. If no listener exists, report that the server is already stopped and finish. If verification is inconclusive, explain that instead of looping. Never claim to have closed a browser window without a browser tool result.`}]};
}
module.exports={terminalFeedbackPolicy};
