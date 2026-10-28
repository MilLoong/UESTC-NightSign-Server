"""Optional ServerChan Turbo notifications; never forward private error details."""
import json
import re
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def notification(result):
    labels = {
        'checked_in_confirmed': '签到成功（已复查）',
        'already_checked_in': '今日已签到',
        'accepted_unconfirmed': '提交已受理，待确认',
        'result_unknown': '签到结果不确定，请手动查看',
    }
    label = labels.get(result.get('stage'), '签到任务失败')
    day = result.get('businessDate', '')
    if not isinstance(day, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', day):
        day = '请查看任务日志'
    return {'title': '晚安成电：' + label, 'desp': '日期：' + day + '\n\n' + label}


def send_notification(result, path, opener=None):
    try:
        if not path.exists():
            return {'notification': 'disabled'}
        config = json.loads(path.read_text(encoding='utf-8'))
        if config.get('enabled') is False:
            return {'notification': 'disabled'}
        key = config.get('sendKey', '')
        if not isinstance(key, str) or not re.fullmatch(r'SCT[A-Za-z0-9_-]{10,200}', key):
            return {'notification': 'failed'}
        request = Request('https://sctapi.ftqq.com/' + key + '.send',
                          data=urlencode(notification(result)).encode(), method='POST',
                          headers={'Content-Type': 'application/x-www-form-urlencoded'})
        with (opener or build_opener(NoRedirect())).open(request, timeout=8) as response:
            body = json.loads(response.read(65537))
            if response.status != 200 or body.get('code') != 0:
                return {'notification': 'failed'}
        return {'notification': 'accepted'}
    except Exception:
        return {'notification': 'failed'}
