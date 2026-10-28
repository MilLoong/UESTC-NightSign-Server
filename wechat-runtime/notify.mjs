import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function notification(result) {
  const labels = { notification_test: '通知通道测试（未执行签到）', checked_in_confirmed: '签到成功（已复查）', already_checked_in: '今日已签到',
    accepted_unconfirmed: '提交已受理，待确认', result_unknown: '签到结果不确定，请手动查看' };
  return { title: `晚安成电：${labels[result.stage] || '签到任务失败'}`,
    desp: `日期：${/^\d{4}-\d{2}-\d{2}$/.test(result.businessDate || '') ? result.businessDate : '请查看任务日志'}\n\n${
      labels[result.stage] || '请查看服务器任务日志，必要时重新授权。'}` };
}

export async function sendNotification(result, { path = new URL('./notify.json', import.meta.url), fetcher = fetch } = {}) {
  try {
    let config;
    try { config = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { notification: 'disabled' }; throw error; }
    if (config.enabled === false) return { notification: 'disabled' };
    if (!/^SCT[A-Za-z0-9_-]{10,200}$/.test(config.sendKey || '')) throw new Error('INVALID_KEY');
    const response = await fetcher(`https://sctapi.ftqq.com/${config.sendKey}.send`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(notification(result)),
    });
    if (!response.ok) throw new Error('HTTP_ERROR');
    const body = await response.json();
    if (body.code !== 0) throw new Error('API_ERROR');
    return { notification: 'accepted' };
  } catch {
    // Never log request URLs, remote messages or transport errors containing the SendKey.
    return { notification: 'failed' };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await sendNotification({ stage: 'notification_test' });
  console.log(JSON.stringify(result));
  if (result.notification !== 'accepted') process.exitCode = 1;
}
