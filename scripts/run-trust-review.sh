#!/usr/bin/env bash
# Loads settings from .trustreviewenv beside this script. Requires Python 3.
set -euo pipefail
set +x
trustreview_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec python3 - "$trustreview_dir" "$@" <<'PY'
import argparse
import fnmatch
import json
import math
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen

DEFAULT_PATTERNS = 'prompts/**,agents/**,evals/**,**/*.prompt,**/*.prompt.txt,**/*.jinja,**/*.jinja2,**/system_prompt*,**/model_config*,**/llm_config*,**/ai_config*,**/*agent*.py,**/*agent*.ts,**/*agent*.js,**/chains/**'
MAX_PATHS = 3000


class ReviewError(Exception):
    pass


class ApiError(ReviewError):
    def __init__(self, status):
        self.status = status
        # Response bodies can contain credentials echoed by intermediaries.
        super().__init__(f'HTTP {status}')


def load_settings(path):
    """Read literal KEY=value settings; never execute shell commands from the file."""
    settings = dict(os.environ)
    if path.exists():
        try:
            lines = path.read_text().splitlines()
        except (OSError, UnicodeError):
            raise ReviewError(f'Cannot read settings file {path.name}') from None
        for number, raw in enumerate(lines, 1):
            line = raw.strip()
            if not line or line.startswith('#'):
                continue
            if line.startswith('export '):
                line = line[7:].strip()
            key, separator, value = line.partition('=')
            if not separator or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key.strip()):
                raise ReviewError(f'Invalid setting on line {number} of {path.name}')
            try:
                parts = shlex.split(value, comments=True)
            except ValueError:
                raise ReviewError(f'Invalid quoting on line {number} of {path.name}') from None
            if len(parts) > 1:
                raise ReviewError(f'Quote values containing spaces on line {number} of {path.name}')
            settings[key.strip()] = parts[0] if parts else ''
    return settings


def integer(settings, key, default, low, high):
    try:
        value = int(settings.get(key, str(default)))
    except ValueError:
        raise ReviewError(f'{key} must be an integer') from None
    if not low <= value <= high:
        raise ReviewError(f'{key} must be between {low} and {high}')
    return value


def boolean(settings, key, default):
    value = settings.get(key, str(default)).lower()
    if value not in ('true', 'false'):
        raise ReviewError(f'{key} must be true or false')
    return value == 'true'


def api(url, token, payload=None, github=False, timeout=30, method=None):
    headers = {'Accept': 'application/vnd.github+json' if github else 'application/json'}
    if token:
        headers['Authorization' if github else 'X-API-Key'] = f'Bearer {token}' if github else token
    if github:
        headers['X-GitHub-Api-Version'] = '2022-11-28'
    if payload is not None:
        headers['Content-Type'] = 'application/json'
    req = Request(url, data=json.dumps(payload).encode() if payload is not None else None,
                  headers=headers, method=method)
    try:
        with urlopen(req, timeout=timeout) as response:
            raw = response.read(4_000_001)
        if len(raw) > 4_000_000:
            raise ReviewError('API response exceeded the runner size limit')
        return json.loads(raw)
    except HTTPError as exc:
        raise ApiError(exc.code) from None
    except (URLError, TimeoutError, OSError):
        raise ReviewError('API connection failed; check the configured URL and network') from None
    except (ValueError, UnicodeError):
        raise ReviewError('API returned an invalid JSON response') from None


def matches(path, patterns):
    return any(fnmatch.fnmatchcase(path, pattern)
               or fnmatch.fnmatchcase(path, '**/' + pattern)
               or (pattern.startswith('**/') and fnmatch.fnmatchcase(path, pattern[3:]))
               for pattern in patterns)


def collect_paths(repo, number, pr, token, patterns):
    files = []
    for page in range(1, 31):
        batch = api(f'https://api.github.com/repos/{repo}/pulls/{number}/files?per_page=100&page={page}', token, github=True)
        if not isinstance(batch, list):
            raise ReviewError('GitHub returned an invalid changed-file list')
        files.extend(batch)
        if len(batch) < 100:
            break
    if len(files) != pr.get('changed_files'):
        raise ReviewError('GitHub did not return the complete changed-file list')
    paths = [f['filename'] for f in files if matches(f['filename'], patterns)
             or matches(f.get('previous_filename', ''), patterns)]
    validate_paths(paths)
    return list(dict.fromkeys(paths))


def validate_paths(paths):
    if not isinstance(paths, list) or len(paths) > MAX_PATHS:
        raise ReviewError(f'Paths must be a JSON array with at most {MAX_PATHS} entries')
    for path in paths:
        if (not isinstance(path, str) or not path or len(path) > 512 or path.startswith('/')
                or '\x00' in path or any(part in ('.', '..') for part in path.split('/'))):
            raise ReviewError('Each entry must be a relative repository file path (max 512 characters)')


def normalize_website_domain(value):
    domain = value.strip().lower()
    labels = domain.split('.')
    if (len(domain) > 253 or len(labels) < 2 or labels[-1].isdigit()
            or labels[-1] in ('localhost', 'local', 'internal', 'test', 'invalid', 'example')
            or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label) for label in labels)):
        raise ReviewError('Website domain must be an explicit public DNS domain, without a URL, path, or port')
    return domain


def scan_website(base, domain):
    result = {'domain': domain, 'status': 'unavailable', 'trust_score': None}
    try:
        data = api(f'{base}/v1/public/site-score/{quote(domain, safe="")}/', '', timeout=15)
        score = data.get('trust_score') if isinstance(data, dict) else None
        if (isinstance(data, dict) and data.get('domain') == domain and data.get('assessed') is True
                and type(score) in (int, float) and math.isfinite(score) and 0 <= score <= 100):
            result.update(status='assessed', trust_score=score)
    except ReviewError:
        pass  # Informational scan failures never alter the PR result or exit code.
    return result


def website_comment(website):
    score = (f"Website TrustScore: **{website['trust_score']}/100**." if website['status'] == 'assessed'
             else 'Website TrustScore: unavailable.')
    return ('\n\n---\n### Website TrustScore — informational\n\n'
            f"Website: `{website['domain']}`\n\n{score}\n\n"
            'This is a website assessment (possibly cached), not a review of this PR or its code. '
            'It does not affect the PR gate, threshold, or exit code.')


def publish_result(repo, number, head_sha, result, token, website=None):
    verified = result.get('status') == 'passed' and result.get('passed') is True and result.get('pr_diff_evaluated') is True
    state = 'success' if verified else 'failure' if result.get('status') == 'failed' and result.get('pr_diff_evaluated') is True else 'error'
    description = ('Verified PR diff evaluation passed' if verified else
                   'Not available: PR diff evaluator has not shipped' if result.get('status') == 'not_available' else
                   'Trust Review did not pass; no passing gate issued')
    # Status first: failure to post a comment must never suppress the gate.
    api(f'https://api.github.com/repos/{repo}/statuses/{head_sha}', token, {
        'state': state, 'context': 'trustmodel/trust-review', 'description': description,
    }, github=True)
    current = api(f'https://api.github.com/repos/{repo}/pulls/{number}', token, github=True)
    if current['head']['sha'] != head_sha:
        return  # a superseded push may report its status but cannot replace the current comment
    marker = '<!-- trustmodel-trust-review -->'
    comment_id = None
    for page in range(1, 11):
        comments = api(f'https://api.github.com/repos/{repo}/issues/{number}/comments?per_page=100&page={page}', token, github=True)
        comment_id = next((c['id'] for c in comments if marker in (c.get('body') or '') and c.get('user', {}).get('type') == 'Bot'), None)
        if comment_id or len(comments) < 100:
            break
    else:
        raise ReviewError('Too many comment pages to safely locate the review comment')
    if not result.get('pr_diff_evaluated'):
        body = marker + '\n## Trust Review — not available\n\nThe PR diff evaluator is not available. **No code was evaluated and no passing gate was issued.**\n\nThe PR result is independent of any informational website assessment below.'
    else:
        body = marker + f"\n## Trust Review — {'passed' if verified else 'not passed'}\n\nPR diff evaluated: yes. Score: {result.get('trust_score')}/100."
    if website:
        body += website_comment(website)
    url = (f'https://api.github.com/repos/{repo}/issues/comments/{comment_id}' if comment_id else
           f'https://api.github.com/repos/{repo}/issues/{number}/comments')
    api(url, token, {'body': body}, github=True, method='PATCH' if comment_id else 'POST')


def main(argv, script_dir):
    parser = argparse.ArgumentParser(
        prog='run-trust-review.sh',
        description='Submit and poll a Trust Review using settings in .trustreviewenv beside this script.',
        epilog='Exit codes: 0 verified pass or successful dry run; 2 not available/failed; 3 setup/API/timeout error. '
               'This preview records paths only. The diff evaluator is not available; no passing gate is issued.')
    parser.add_argument('pr_url', nargs='?', help='https://github.com/OWNER/REPO/pull/NUMBER')
    parser.add_argument('--repo', help='OWNER/REPO; alternatively set TRUSTREVIEW_REPO')
    parser.add_argument('--pr', type=int, help='PR number; alternatively set TRUSTREVIEW_PR')
    parser.add_argument('--env-file', type=Path, default=Path(script_dir) / '.trustreviewenv')
    parser.add_argument('--paths', type=Path, help='Use a local JSON array of file paths instead of auto-detection')
    parser.add_argument('--website-domain', help='Optional informational website score for an explicit public domain; never a PR score')
    parser.add_argument('--dry-run', action='store_true', help='Read GitHub and show a sanitized summary; do not submit or post')
    parser.add_argument('--json', action='store_true', help='Print the final API result as JSON on stdout')
    args = parser.parse_args(argv)
    settings = load_settings(args.env_file)
    repo = args.repo or settings.get('TRUSTREVIEW_REPO', '')
    number = args.pr if args.pr is not None else settings.get('TRUSTREVIEW_PR', '')
    if args.pr_url:
        match = re.fullmatch(r'https://github\.com/([\w.-]+/[\w.-]+)/pull/([0-9]+)/?', args.pr_url)
        if not match or args.repo or args.pr:
            raise ReviewError('Use one GitHub PR URL, or --repo and --pr')
        repo, number = match.groups()
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo):
        raise ReviewError('Provide a PR URL or set TRUSTREVIEW_REPO and TRUSTREVIEW_PR')
    try:
        number = int(number)
    except (ValueError, TypeError):
        raise ReviewError('A positive PR number is required') from None
    if not 1 <= number <= 2_147_483_647:
        raise ReviewError('A positive PR number is required')
    base = settings.get('TRUSTMODEL_BASE_URL', '').rstrip('/')
    parsed = urlsplit(base)
    if (parsed.scheme not in ('https', 'http') or not parsed.hostname or parsed.username
            or parsed.password or parsed.path or parsed.query or parsed.fragment):
        raise ReviewError('TRUSTMODEL_BASE_URL must be the gateway origin, without /api or /v1')
    if parsed.scheme == 'http' and parsed.hostname not in ('localhost', '127.0.0.1', '::1'):
        raise ReviewError('Use HTTPS for remote gateways; HTTP is allowed only for localhost')
    domain = args.website_domain if args.website_domain is not None else settings.get('TRUSTREVIEW_WEBSITE_DOMAIN', '')
    domain = normalize_website_domain(domain) if domain else ''
    key = settings.get('TRUSTMODEL_API_KEY', '')
    token = settings.get('GITHUB_TOKEN') or settings.get('GH_TOKEN')
    if not token:
        try:
            token = subprocess.check_output(['gh', 'auth', 'token'], stderr=subprocess.DEVNULL, text=True).strip()
        except (OSError, subprocess.CalledProcessError):
            raise ReviewError('Set GITHUB_TOKEN in .trustreviewenv or sign in using gh auth login') from None
    post_github = boolean(settings, 'TRUSTREVIEW_POST_GITHUB', True)
    threshold = integer(settings, 'TRUSTREVIEW_THRESHOLD', 65, 1, 100)
    timeout = integer(settings, 'TRUSTREVIEW_TIMEOUT_SECONDS', 300, 10, 3600)
    interval = integer(settings, 'TRUSTREVIEW_POLL_SECONDS', 3, 1, 60)
    pr = api(f'https://api.github.com/repos/{repo}/pulls/{number}', token, github=True)
    if pr.get('state') != 'open':
        raise ReviewError('Use an open test PR')
    if args.paths:
        try:
            paths = json.loads(args.paths.read_text())
        except (OSError, ValueError):
            raise ReviewError('Cannot read the paths JSON file') from None
        validate_paths(paths)
    else:
        patterns = [p.strip() for p in settings.get('TRUSTREVIEW_DETECT', DEFAULT_PATTERNS).split(',') if p.strip()]
        paths = collect_paths(repo, number, pr, token, patterns)
    print(f'{repo}#{number} | head {pr["head"]["sha"][:12]} | {len(paths)} matching file path(s)', file=sys.stderr)
    print(f'Gateway: {base} | GitHub posting: {post_github} | requested threshold: {threshold}', file=sys.stderr)
    if domain:
        print(f'Optional website: {domain} | informational only; never affects PR status', file=sys.stderr)
    if args.dry_run:
        print('Dry run complete. No review submitted; no comments or statuses posted.', file=sys.stderr)
        return 0
    payload = {
        'repo': repo, 'pr_number': number, 'base_sha': pr['base']['sha'], 'head_sha': pr['head']['sha'],
        'changed_files': paths, 'threshold': threshold, 'framework': settings.get('TRUSTREVIEW_FRAMEWORK', ''),
    }
    exit_error = False
    try:
        if key:
            result = api(f'{base}/v1/pr-trust/review/', key, payload)
            if not isinstance(result, dict):
                raise ReviewError('Invalid Trust Review response')
            deadline = time.monotonic() + timeout
            while result.get('status') in ('pending', 'running'):
                run_id = result.get('run_id')
                if not isinstance(run_id, str) or not re.fullmatch(r'[0-9a-fA-F-]{36}', run_id):
                    raise ReviewError('API did not return a valid run_id')
                if time.monotonic() >= deadline:
                    raise ReviewError('Polling timed out; no fallback assessment was performed')
                time.sleep(min(interval, max(0, deadline-time.monotonic())))
                result = api(f'{base}/v1/pr-trust/review/{run_id}/', key, timeout=min(15, max(1, deadline-time.monotonic())))
                if not isinstance(result, dict):
                    raise ReviewError('Invalid Trust Review polling response')
        else:
            result = {'status': 'not_available', 'passed': False, 'pr_diff_evaluated': False,
                      'trust_score': None, 'reason': 'api_key_missing',
                      'message': 'PR diff evaluation is not available. An API key is required to record metadata.'}
        if result.get('status') not in ('not_available', 'passed', 'failed', 'error'):
            raise ReviewError('Unknown Trust Review status')
        if type(result.get('passed')) is not bool or type(result.get('pr_diff_evaluated')) is not bool:
            raise ReviewError('Missing gate decision or evaluation evidence')
        if result.get('passed') or result.get('status') == 'passed':
            score = result.get('trust_score')
            if not (result.get('status') == 'passed' and result.get('passed') is True
                    and result.get('pr_diff_evaluated') is True and type(score) in (int, float) and 0 <= score <= 100):
                raise ReviewError('Unverified passing result rejected')
    except ReviewError:
        # Never echo response bodies or replace an outage with a website score.
        exit_error = True
        result = {'status': 'error', 'passed': False, 'pr_diff_evaluated': False,
                  'trust_score': None, 'message': 'Trust Review service could not complete the request. No passing gate was issued.'}
    website = scan_website(base, domain) if domain else None
    if website:
        result['website_scan'] = website
    if post_github:
        try:
            publish_result(repo, number, pr['head']['sha'], result, token, website)
        except ReviewError:
            exit_error = True
            print('GitHub publication failed. Check token permissions; no alternate passing status was issued.', file=sys.stderr)
    passed = result['status'] == 'passed' and result['passed'] is True and result['pr_diff_evaluated'] is True
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"Status: {result['status']} | Passed: {passed} | PR diff evaluated: {result['pr_diff_evaluated']}")
        print(result.get('message', 'Review completed.'))
        if website:
            print(f"Website TrustScore (informational): {website['domain']} | {website['trust_score'] if website['trust_score'] is not None else 'unavailable'} | not a PR code review")
        if result.get('run_id'):
            print(f"Run: {result['run_id']}")
    return 3 if exit_error else 0 if passed else 2



if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[2:], sys.argv[1]))
    except (ReviewError, OSError, KeyError, TypeError, ValueError) as exc:
        message = str(exc) if isinstance(exc, ReviewError) else 'Unexpected local/API data error'
        print(f'Trust Review: {message}', file=sys.stderr)
        sys.exit(3)
    except KeyboardInterrupt:
        print('Polling stopped; any submitted review continues on the backend.', file=sys.stderr)
        sys.exit(130)
PY
